const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

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
function signedHeaders({ method, url, payload = "", contentType, extraHeaders = {}, now = new Date(), cfg = S3 }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(payload);

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
  return fetch(url, {
    headers: signedHeaders({ method: "GET", url, cfg: S3 }),
    signal: AbortSignal.timeout(S3_TIMEOUT_MS)
  });
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
async function commitAs(file, key) {
  if (!usingS3 || !file) return file?.filename || null;
  const body = await fsp.readFile(file.path);
  await s3Put(key, body, S3);
  if (mirroring) {
    try {
      await s3Put(key, body, MIRROR);
    } catch (err) {
      console.error(`[storage] mirror write failed for ${key}: ${err.message}`);
    }
  }
  await fsp.rm(file.path, { force: true });
  return key;
}

async function commit(file) {
  if (!usingS3 || !file) return file?.filename || null;

  // Whole-file buffer: capped by multer at 8MB (images) or 64MB (media).
  // Fine for those sizes; revisit if the media ceiling ever goes up.
  const body = await fsp.readFile(file.path);

  // The primary must succeed - the caller writes a database row pointing at
  // this object, so a failure here has to reject the upload.
  await s3Put(file.filename, body, S3);

  // The mirror is best-effort and deliberately not part of that contract.
  // A second bucket exists to survive losing the first one; letting it
  // reject uploads would make the site *less* reliable, not more. A miss
  // is logged and healed by the next `migrate-uploads-to-s3.js --mirror`.
  if (mirroring) {
    try {
      await s3Put(file.filename, body, MIRROR);
    } catch (err) {
      console.error(`[storage] mirror write failed for ${file.filename}: ${err.message}`);
    }
  }

  await fsp.rm(file.path, { force: true });
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
function discardTemp(file) {
  if (file?.path) fs.rmSync(file.path, { force: true });
}

module.exports = {
  publicUrl,
  commit,
  commitAs,
  remove,
  discardTemp,
  describe,
  isRemote: () => usingS3,
  isMirroring: () => mirroring,
  servesFromApp,
  getObject,
  // exported for the migration script and the signer's test
  _internal: { signedHeaders, s3Put, s3Delete, keyFor, s3Configured, bucketConfigured, S3, MIRROR }
};
