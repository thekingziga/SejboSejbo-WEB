/**
 * Creating a post, for the website form and the app API alike. They used
 * to be two copies of the same sequence, and every rule added to one had
 * to be remembered in the other - this is the one place uploads are
 * checked, limited, screened and stored.
 */
const i18n = require("./i18n");
const { statements } = require("./db");
const storage = require("./storage");
const mediaQueue = require("./mediaQueue");
const push = require("./push");
const subscribers = require("./subscribers");
const moderation = require("./moderation");
const { createQuota } = require("./rateLimit");
const { getClientIp } = require("./ip");
const { kindForMime, oversizeMessage, decodePoster, posterKeyFor } = require("./upload");

/** Three posts an hour, counted per address AND per device, whichever runs
 * out first: a new network alone or cleared cookies alone does not reset
 * it. Only posts that went through count, plus the attempts that are
 * abuse in themselves (a duplicate, a repost) - a typo in the form or a
 * file that is too big does not cost one of the three. */
const UPLOADS_PER_HOUR = 3;
const quota = createQuota({ windowMs: 60 * 60 * 1000, max: UPLOADS_PER_HOUR });

function quotaKeys(req, deviceId) {
  return [`ip:${getClientIp(req)}`, deviceId ? `device:${deviceId}` : null].filter(Boolean);
}

/** Takes a slot for these keys before the file is received, so parallel
 * uploads cannot all slip past the check before any of them is counted.
 * Returns 0 when the slot is taken, else the seconds until one frees up. */
function reserveUpload(keys) {
  const wait = Math.max(0, ...keys.map((key) => quota.retryAfter(key)));
  if (!wait) keys.forEach((key) => quota.hit(key));
  return wait;
}

/** Gives the slot back when the attempt turned out not to count. */
function releaseUpload(keys) {
  keys.forEach((key) => quota.release(key));
}

function quotaMessage(lang, retryAfter) {
  return i18n[lang].uploadQuota
    .replace("{count}", String(UPLOADS_PER_HOUR))
    .replace("{minutes}", String(Math.ceil(retryAfter / 60)));
}

function fail(status, code, message, counts = false) {
  return { ok: false, status, code, message, counts };
}

/**
 * @returns {Promise<{ok: true, post: object, held: boolean, counts: true}
 *   | {ok: false, status: number, code: string, message: string, counts: boolean}>}
 * The temp file is always dealt with: stored on success, removed otherwise.
 */
async function createPost({ file, title: rawTitle, description: rawDescription, poster, lang }) {
  const copy = i18n[lang];
  const title = String(rawTitle || "").trim();
  const description = String(rawDescription || "").trim();

  if (!title || (!description && !file)) {
    storage.discardTemp(file);
    return fail(400, "missing", copy.notEnoughBody);
  }

  // multer enforces one ceiling for every file; this is where images are
  // actually held to the image limit rather than the video one.
  const tooBig = oversizeMessage(file, lang);
  if (tooBig) {
    storage.discardTemp(file);
    return fail(413, "too_large", tooBig);
  }

  const kind = file ? kindForMime(file.mimetype) : "story";
  let contentHash = null;
  if (file) {
    contentHash = await storage.sha256File(file.path);
    if (await statements.uploadByHash.get(contentHash)) {
      storage.discardTemp(file);
      return fail(409, "duplicate", copy.uploadDuplicate, true);
    }
  }

  const scan = await moderation.scanUpload({ filePath: file?.path, mimetype: file?.mimetype, kind, title, description });
  if (scan.verdict === "reject") {
    storage.discardTemp(file);
    console.warn(`[upload] rejected "${title.slice(0, 60)}": ${scan.reason}`);
    return fail(422, scan.code, copy.uploadRepost, true);
  }
  const held = scan.verdict === "hold";

  // Store the file before the row exists, so a storage failure can't leave
  // a post referencing a missing object. Stored under its real name, so
  // the post is playable as soon as this returns; large videos are only
  // queued to be made smaller later.
  const queueThis = file && mediaQueue.shouldQueue(kind, file.size);
  if (file) {
    try {
      await storage.commit(file);
    } catch (err) {
      storage.discardTemp(file);
      console.error(`[upload] failed: ${err.message}`);
      return fail(502, "storage", copy.notEnoughBody);
    }
  }

  // A still for the grid tile. Best-effort in every sense: it only exists
  // if the client captured one, and a failure to store it must not fail an
  // upload whose actual media is already safely in the bucket.
  let posterKey = null;
  const posterBytes = kind === "video" ? decodePoster(poster) : null;
  if (posterBytes) {
    const key = posterKeyFor(file.filename);
    try {
      await storage.putBytes(key, posterBytes);
      posterKey = key;
    } catch (err) {
      console.error(`[upload] poster for ${file.filename} failed: ${err.message}`);
    }
  }

  const result = await statements.insertUpload.run(
    title.slice(0, 120),
    description.slice(0, 1200),
    file ? file.filename : null,
    file ? file.originalname : null,
    kind,
    posterKey,
    held,
    held ? scan.reason : null,
    contentHash
  );
  const post = await statements.uploadByIdAny.get(result.lastInsertRowid);
  if (held) console.warn(`[upload] held post ${post.id} for review: ${scan.reason}`);

  if (queueThis) await mediaQueue.enqueue({ postId: post.id, filename: post.filename, kind: post.kind });
  if (!held) announce(post);
  return { ok: true, post, held, counts: true };
}

/** Push and email for a post that just went public. Not awaited, and never
 * allowed to throw: notifying is slow (one FCM request per device, one
 * SMTP send per subscriber) and must not delay or fail what triggered it. */
function announce(post) {
  Promise.allSettled([push.announcePost(post), subscribers.announcePost(post)])
    .catch((err) => console.error(`[upload] announce failed: ${err.message}`));
}

module.exports = { createPost, announce, quotaKeys, reserveUpload, releaseUpload, quotaMessage, UPLOADS_PER_HOUR };
