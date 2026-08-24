const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const http = require("http");
const https = require("https");

const { uploadDir } = require("./db");

/** Where uploaded files live. Local disk by default - the site has always
 * bind-mounted ./uploads off the Pi's SD card and that keeps working with
 * zero configuration.
 *
 * Set STORAGE_DRIVER=s3 (plus the S3_* vars) to put new uploads in an
 * S3-compatible bucket instead. Everything that touches a file goes through
 * this module, so that switch is the whole change - no route, template or
 * serializer knows which driver is active.
 *
 * Deliberately no AWS SDK: signing a PUT is ~40 lines of node:crypto, and
 * @aws-sdk/client-s3 would add tens of megabytes to an image that runs on a
 * Raspberry Pi. It also means any S3-compatible provider works - Cloudflare
 * R2, Backblaze B2, Hetzner, MinIO - not just AWS. */
const DRIVER = (process.env.STORAGE_DRIVER || "local").toLowerCase();

/** Every call to the bucket is bounded.
 *
 * Learned the hard way: with an endpoint that accepted connections but
 * stalled on large bodies, uploads hung for ten minutes rather than
 * failing. Unbounded, that is worse in production than an error - the
 * request never returns, the client waits, and because /uploads is now
 * served through this module a stalled bucket would hang every image
 * request on the site rather than just the upload that caused it.
 *
 * Generous enough for a 64MB video on a slow link, short enough that a
 * black-holed endpoint surfaces as a clear failure. */
const S3_TIMEOUT_MS = Number(process.env.S3_TIMEOUT_MS || 60000);

/** Uploads get their own, far longer budget: 60s is right for a HEAD, but
 * a 500MB video going to a mirror across the internet legitimately takes
 * minutes, and timing that out fails uploads that were working. */
const S3_UPLOAD_TIMEOUT_MS = Number(process.env.S3_UPLOAD_TIMEOUT_MS || 20 * 60 * 1000);

/** Reads one bucket's settings from an env prefix, so the primary
 * (S3_*) and the mirror (S3_MIRROR_*) are described the same way. */
function readBucketConfig(envPrefix) {
  const get = (name) => process.env[`${envPrefix}${name}`] || "";
  return {
    label: envPrefix === "S3_" ? "primary" : "mirror",
    bucket: get("BUCKET"),
    region: get("REGION") || "auto",
    endpoint: get("ENDPOINT").replace(/\/$/, ""),
    accessKeyId: get("ACCESS_KEY_ID"),
    secretAccessKey: get("SECRET_ACCESS_KEY"),
    // Where the browser fetches objects from. Usually a CDN or bucket
    // domain; falls back to the API endpoint, which only works on public
    // buckets. Only meaningful for the primary - nothing is served from
    // the mirror unless you deliberately switch them over.
    publicBaseUrl: get("PUBLIC_BASE_URL").replace(/\/$/, ""),
    // Falls back to the primary's prefix on purpose. S3_PREFIX is how a
    // test stack is kept out of production's way, and having it sandbox
    // only the primary is a trap: the test instance quietly reads, writes
    // and DELETES production objects in the mirror bucket while looking
    // perfectly isolated. That is not hypothetical - it destroyed the
    // mirror copies of two live posts. Set S3_MIRROR_PREFIX explicitly
    // only if you really want the two buckets laid out differently.
    prefix: (get("PREFIX") || (envPrefix === "S3_" ? "" : process.env.S3_PREFIX || "")).replace(/^\/|\/$/g, "")
  };
}

const S3 = readBucketConfig("S3_");

/** Optional second bucket that receives a copy of every upload.
 *
 * Best-effort by design: the primary write must succeed for an upload to be
 * accepted, but a failing mirror only logs. A mirror that is down, full or
 * misconfigured must never stop someone posting - it exists so that losing
 * one provider (or one accidental bucket deletion) doesn't lose the files,
 * not as a second thing that can break the site.
 *
 * It is a *mirror*, not a replica with its own consistency guarantees: if a
 * mirror write fails, that object is missing from the mirror until the next
 * `migrate-uploads-to-s3.js --mirror` run copies it across. Run that
 * periodically if the mirror matters. */
const MIRROR = readBucketConfig("S3_MIRROR_");

const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".weba": "audio/webm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime"
};

function bucketConfigured(cfg) {
  return Boolean(cfg.bucket && cfg.endpoint && cfg.accessKeyId && cfg.secretAccessKey);
}

function s3Configured() {
  return bucketConfigured(S3);
}

/** True only when S3 is both selected AND fully configured. A half-configured
 * bucket falls back to local disk rather than taking the site down - the same
 * graceful-degradation rule the mail, donation and AI modules follow. */
const usingS3 = DRIVER === "s3" && s3Configured();

/** Mirroring only makes sense when the primary is actually in use. A
 * mirror configured while the driver is local is ignored rather than
 * silently half-working. */
const mirroring = usingS3 && bucketConfigured(MIRROR);

if (usingS3 && !mirroring && (MIRROR.bucket || MIRROR.endpoint || MIRROR.accessKeyId)) {
  console.error("[storage] S3_MIRROR_* is partly set but incomplete - uploads will NOT be mirrored");
}

if (DRIVER === "s3" && !usingS3) {
  console.error("[storage] STORAGE_DRIVER=s3 but S3_BUCKET/S3_ENDPOINT/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY are incomplete - falling back to local disk");
}

function describe() {
  if (!usingS3) return DRIVER === "s3" ? "local disk (S3 selected but misconfigured)" : "local disk";
  const primary = `s3: ${S3.bucket} at ${S3.endpoint}${S3.prefix ? ` (prefix ${S3.prefix})` : ""}`;
  return mirroring ? `${primary}  + mirror ${MIRROR.bucket} at ${MIRROR.endpoint}` : primary;
}

function keyFor(filename, cfg = S3) {
  return cfg.prefix ? `${cfg.prefix}/${filename}` : filename;
}

function contentTypeFor(filename) {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] || "application/octet-stream";
}

// --------------------------------------------------------------- SigV4 ---

function sha256hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key, str) {
  return crypto.createHmac("sha256", key).update(str, "utf8").digest();
}

/** Minimal AWS Signature V4 for S3. Returns the headers to send.
 *
 * Only signs what this app actually issues: single-shot PUT/DELETE/GET with
 * no query string. Object keys are generated by lib/upload.js as
 * `<timestamp>-<hex><ext>`, so they never contain characters that need
 * URI escaping - the canonical path is used as-is. Anything that starts
 * accepting user-supplied keys must revisit that. */
function signedHeaders({ method, url, payload = "", payloadHash: precomputed, contentType, extraHeaders = {}, now = new Date(), cfg = S3 }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  // Streaming uploads hash the file separately - see sha256File().
  const payloadHash = precomputed || sha256hex(payload);

  const headers = {
    host: u.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...extraHeaders
  };
  if (contentType) headers["content-type"] = contentType;

  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names.map((n) => {
    const value = Object.entries(headers).find(([k]) => k.toLowerCase() === n)[1];
    return `${n}:${String(value).trim().replace(/\s+/g, " ")}\n`;
  }).join("");
  const signedHeaderList = names.join(";");

  const canonicalRequest = [
    method,
    u.pathname,
    u.searchParams.toString(),
    canonicalHeaders,
    signedHeaderList,
    payloadHash
  ].join("\n");

  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaderList}, Signature=${signature}`
  };
}

function objectUrl(filename, cfg = S3) {
  return `${cfg.endpoint}/${cfg.bucket}/${keyFor(filename, cfg)}`;
}

/** sha256 of a file without holding it in memory. SigV4 needs the payload
 * hash before the request starts, which is the reason the old code read
 * the whole upload into a Buffer. Hashing in chunks costs one extra read
 * of a file that is already on local disk. */
async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

/** PUTs a file straight from disk with constant memory.
 *
 * Deliberately node:http rather than fetch. An earlier attempt at this
 * used fetch with a ReadableStream body and measured no improvement at
 * all - 476MB file, 586MB RSS - because undici buffers the whole request
 * body before sending it. Node's own client streams it, which is the
 * difference between memory tracking file size and memory being flat.
 *
 * Content-Length is set explicitly so no chunked framing is used; S3
 * rejects chunked bodies that are not aws-chunked. */
function s3PutFile(key, filePath, payloadHash, size, cfg = S3) {
  const url = new URL(objectUrl(key, cfg));
  const headers = {
    ...signedHeaders({ method: "PUT", url: url.href, payloadHash, contentType: contentTypeFor(key), cfg }),
    "content-length": String(size)
  };
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "PUT",
      headers
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { if (body.length < 400) body += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`S3 PUT ${res.statusCode} (${cfg.label}): ${body.slice(0, 200)}`));
      });
      res.on("error", reject);
    });
    req.setTimeout(S3_UPLOAD_TIMEOUT_MS, () => req.destroy(new Error(`S3 PUT timed out (${cfg.label})`)));
    req.on("error", reject);
    const source = fs.createReadStream(filePath);
    source.on("error", (err) => { req.destroy(err); reject(err); });
    source.pipe(req);
  });
}

async function s3Put(filename, body, cfg = S3) {
  const contentType = contentTypeFor(filename);
  const url = objectUrl(filename, cfg);
  const res = await fetch(url, {
    method: "PUT",
    headers: signedHeaders({ method: "PUT", url, payload: body, contentType, cfg }),
    body,
    signal: AbortSignal.timeout(S3_TIMEOUT_MS)
  });
  if (!res.ok) {
    throw new Error(`S3 PUT ${res.status} (${cfg.label}): ${(await res.text()).slice(0, 200)}`);
  }
}

async function s3Delete(filename, cfg = S3) {
  const url = objectUrl(filename, cfg);
  const res = await fetch(url, {
    method: "DELETE",
    headers: signedHeaders({ method: "DELETE", url, cfg }),
    signal: AbortSignal.timeout(S3_TIMEOUT_MS)
  });
  // 404 is fine - the goal is "it's gone", and it already is.
  if (!res.ok && res.status !== 404) {
    throw new Error(`S3 DELETE ${res.status} (${cfg.label}): ${(await res.text()).slice(0, 200)}`);
  }
}

// ------------------------------------------------------------- public API ---

/** The URL a browser or app should fetch this file from.
 *
 * `origin` is only used by the local driver, which serves files off this
 * same host - S3 URLs are absolute and origin-independent. */
function publicUrl(filename, origin = "") {
  if (!filename) return null;

  // Only send browsers straight at the bucket when there is a URL they can
  // actually reach: a CDN or a public bucket domain, set deliberately via
  // S3_PUBLIC_BASE_URL.
  //
  // Otherwise keep serving from this app's own /uploads path and let it
  // fetch from the bucket. That is the right default for a self-hosted
  // MinIO, which is typically on a private address a visitor's browser
  // cannot route to, and often a private bucket besides. It also means the
  // storage swap is invisible from outside: links people already shared,
  // the app's cached image_url values, and og:image previews all keep
  // working, and the bucket needs no public read policy.
  if (usingS3 && S3.publicBaseUrl) {
    return `${S3.publicBaseUrl}/${keyFor(filename)}`;
  }
  return `${origin}/uploads/${encodeURIComponent(filename)}`;
}

/** True when uploads are in a bucket that browsers can't reach directly, so
 * this app has to serve them itself. */
function servesFromApp() {
  return usingS3 && !S3.publicBaseUrl;
}

/** Fetches an object for the app to stream back to a visitor. Returns the
 * raw fetch Response so the caller can pass through status, content-type
 * and length without buffering the whole file in memory. */
async function getObject(filename) {
  const url = objectUrl(filename, S3);
  // The timeout has to cover reaching the bucket, NOT streaming the body.
  // AbortSignal.timeout aborts the whole operation including the response
  // stream, so a 60s budget silently capped every download at 60s - fine
  // for an image, fatal for a 500MB video going to a phone on mobile data,
  // which aborts mid-stream and 502s a file that was transferring happily.
  // Clearing the timer once the headers are in leaves the body free to
  // take as long as the client needs.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), S3_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: signedHeaders({ method: "GET", url, cfg: S3 }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Server-side copy: the bucket duplicates the object itself, so not one
 * byte travels through this process. Used where the alternative is
 * buffering a whole file just to write it back under another name. */
async function s3Copy(sourceKey, destKey, cfg = S3) {
  const url = objectUrl(destKey, cfg);
  const source = `/${cfg.bucket}/${keyFor(sourceKey, cfg)}`;
  const headers = signedHeaders({
    method: "PUT",
    url,
    contentType: contentTypeFor(destKey),
    extraHeaders: { "x-amz-copy-source": source },
    cfg
  });
  const res = await fetch(url, { method: "PUT", headers, signal: AbortSignal.timeout(S3_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`S3 COPY ${res.status} (${cfg.label}): ${(await res.text()).slice(0, 200)}`);
  }
}

/** Moves a freshly-uploaded temp file into permanent storage.
 *
 * multer always writes to local disk first (streaming straight to S3 would
 * mean chunked signing for a file we have to buffer anyway). On the local
 * driver the file is already where it belongs and this is a no-op; on S3 it
 * gets pushed up and the local copy removed.
 *
 * Throws on a failed upload rather than swallowing it - a post row pointing
 * at an object that isn't there is worse than a failed upload the user can
 * retry. Callers are expected to clean up the temp file on throw. */
/** Stores the file under a different key than its own name.
 *
 * Used for transcoding: the original is put away as `<name>.raw.<ext>`
 * while the post already points at `<name>.<ext>`, which the worker
 * writes later. Same buckets, same mirroring rules. */
/** Writes to the mirror after the response has gone out, then removes the
 * temp file.
 *
 * The mirror used to be written inside the request. It is the slowest leg
 * by far - measured at ~1.3MB/s to MEGA against ~22MB/s to the local
 * bucket - so a 300MB video held the connection open for about four
 * minutes and the proxy returned 504 to a user whose upload had actually
 * worked. Nothing about the mirror needs to block the uploader: the post
 * row points at the primary, and the contract for the mirror has always
 * been best-effort, healed by verify-media.js --repair.
 *
 * Never rejects: this is deliberately not awaited, and an unhandled
 * rejection here would take the process down. */
function mirrorInBackground(key, filePath, payloadHash, size) {
  s3PutFile(key, filePath, payloadHash, size, MIRROR)
    .catch((err) => {
      console.error(`[storage] mirror write failed for ${key}: ${err.message} - verify-media --repair will heal it`);
    })
    .finally(() => {
      fsp.rm(filePath, { force: true }).catch(() => {});
    });
}

async function commitAs(file, key) {
  if (!usingS3 || !file) return file?.filename || null;
  // Hashed once, then streamed to each bucket. Never held in memory.
  const { size } = await fsp.stat(file.path);
  const payloadHash = await sha256File(file.path);
  await s3PutFile(key, file.path, payloadHash, size, S3);
  if (mirroring) {
    // Returns immediately; the temp file is removed when it finishes.
    mirrorInBackground(key, file.path, payloadHash, size);
  } else {
    await fsp.rm(file.path, { force: true });
  }
  return key;
}

async function commit(file) {
  if (!usingS3 || !file) return file?.filename || null;

  // Streamed from disk to each bucket, so memory stays flat no matter how
  // large the upload is. This used to read the whole file into a Buffer
  // and hold it across BOTH bucket writes - including a mirror upload over
  // the internet that can take minutes - which is what made a 500MB
  // ceiling dangerous in the first place.
  const { size } = await fsp.stat(file.path);
  const payloadHash = await sha256File(file.path);

  // The primary must succeed - the caller writes a database row pointing
  // at this object, so a failure here has to reject the upload.
  await s3PutFile(file.filename, file.path, payloadHash, size, S3);

  // The mirror is best-effort and deliberately not part of that contract,
  // so it happens after the uploader has been answered rather than while
  // they wait - see mirrorInBackground().
  if (mirroring) {
    mirrorInBackground(file.filename, file.path, payloadHash, size);
  } else {
    await fsp.rm(file.path, { force: true });
  }

  return file.filename;
}

/** Deletes a stored file. Never throws - removal is always a side effect of
 * some other action (deleting a post, cleaning up a rejected upload), and a
 * storage hiccup must not fail that action or leave a half-deleted post. */
async function remove(filename) {
  if (!filename) return;
  try {
    if (usingS3) await s3Delete(filename, S3);
    else await fsp.rm(path.join(uploadDir, filename), { force: true });
  } catch (err) {
    console.error(`[storage] failed to delete ${filename}: ${err.message}`);
  }

  // Delete from the mirror too, in its own try: a mirror that refuses the
  // delete must not stop the primary's delete from being reported as done.
  // An admin deleting a post expects it gone from both, not resurrected by
  // a later mirror sync.
  if (mirroring) {
    try {
      await s3Delete(filename, MIRROR);
    } catch (err) {
      console.error(`[storage] mirror delete failed for ${filename}: ${err.message}`);
    }
  }
}

/** Synchronous local-only cleanup for the temp file on a rejected upload.
 * Used on paths that reject before commit(), where the file is still on
 * local disk regardless of driver. */
/** Removes temp files left behind by uploads that never finished.
 *
 * Needed because the mirror write now outlives the request: if the process
 * is killed between the primary write and the mirror finishing, the temp
 * file is never cleaned up. Only safe on the S3 driver - with local
 * storage this directory holds the actual uploads, not scratch copies.
 *
 * Called at startup rather than on a timer: a restart is exactly when
 * orphans appear, and it is the only moment nothing can be mid-write. */
async function sweepStaleTemp(maxAgeMs = 6 * 60 * 60 * 1000) {
  if (!usingS3) return 0;
  let removed = 0;
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const name of await fsp.readdir(uploadDir)) {
      const full = path.join(uploadDir, name);
      try {
        const info = await fsp.stat(full);
        if (info.isFile() && info.mtimeMs < cutoff) {
          await fsp.rm(full, { force: true });
          removed += 1;
        }
      } catch { /* raced with something else removing it */ }
    }
  } catch (err) {
    console.error(`[storage] could not sweep temp files: ${err.message}`);
  }
  if (removed) console.log(`[storage] removed ${removed} stale upload temp file(s)`);
  return removed;
}

function discardTemp(file) {
  if (file?.path) fs.rmSync(file.path, { force: true });
}

module.exports = {
  publicUrl,
  commit,
  commitAs,
  remove,
  discardTemp,
  sweepStaleTemp,
  describe,
  isRemote: () => usingS3,
  isMirroring: () => mirroring,
  servesFromApp,
  getObject,
  // exported for the migration script and the signer's test
  s3Copy,
  _internal: { signedHeaders, s3Put, s3Delete, s3Copy, keyFor, s3Configured, bucketConfigured, S3, MIRROR }
};
