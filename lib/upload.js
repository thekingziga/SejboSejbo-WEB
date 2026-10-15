const crypto = require("crypto");
const path = require("path");

const multer = require("multer");

const i18n = require("./i18n");
const { uploadDir } = require("./db");

/** Audio/video uploads are built but OFF by default. Set
 * ENABLE_MEDIA_UPLOADS=true to turn them on. Until then the allowlist,
 * size limit and UI copy behave exactly as they always have - images and
 * GIFs only - so shipping this changes nothing for a running site.
 *
 * Deliberately opt-in rather than opt-out: video is far heavier than
 * images, and this runs off a Raspberry Pi with a bind-mounted SD card. */
const MEDIA_ENABLED = process.env.ENABLE_MEDIA_UPLOADS === "true";

/** UPLOADS_PAUSED=true stops every new post and marketplace listing, on
 * the website and the app alike, while leaving everything already up -
 * and messaging - working. It is a temporary off switch: flip it in .env
 * and recreate the container, no deploy needed. INPUT_PAUSED implies it;
 * both live in lib/pause.js. */
const { uploadsPaused } = require("./pause");

const IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const AUDIO_MIMES = ["audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/webm", "audio/x-m4a"];
const VIDEO_MIMES = ["video/mp4", "video/webm", "video/quicktime"];

const EXT_BY_MIME = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/webm": ".weba",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov"
};

const MB = 1024 * 1024;
const IMAGE_LIMIT = Number(process.env.IMAGE_UPLOAD_LIMIT_MB || 100) * MB;
const MEDIA_LIMIT = Number(process.env.MEDIA_UPLOAD_LIMIT_MB || 500) * MB;

function allowedMimes() {
  return MEDIA_ENABLED ? [...IMAGE_MIMES, ...AUDIO_MIMES, ...VIDEO_MIMES] : IMAGE_MIMES;
}

/** Maps a MIME type to the `kind` column. Callers use this instead of
 * hardcoding "image", so a post knows how to render itself. */
function kindForMime(mimetype) {
  if (AUDIO_MIMES.includes(mimetype)) return "audio";
  if (VIDEO_MIMES.includes(mimetype)) return "video";
  return "image";
}

/** The real ceiling for a given file.
 *
 * multer takes a single fileSize for every upload, so with media on it has
 * to be set to the video limit - which silently let images through at the
 * video ceiling too. (A comment used to claim a per-type check existed
 * here. It did not.) multer cannot see the MIME type before it has written
 * the file, so the honest place to enforce this is after the fact, on the
 * temp file that is already on disk. */
function limitFor(mimetype) {
  return kindForMime(mimetype) === "image" ? IMAGE_LIMIT : MEDIA_LIMIT;
}

/** Returns a ready-to-show message if the file busts its type's limit,
 * or null if it is fine. Callers must discard the temp file on a message. */
function oversizeMessage(file, lang) {
  if (!file) return null;
  const cap = limitFor(file.mimetype);
  if (file.size <= cap) return null;
  return (i18n[lang] || i18n.en).fileTooLarge
    .replace("{limit}", `${Math.round(cap / MB)}MB`)
    .replace("{size}", `${Math.round(file.size / MB)}MB`);
}

/** Turns a multer rejection into {status, message}, or null if this is not
 * one. Shared, because uploads can fail under two different Express error
 * handlers - the JSON one that covers /api/ and the HTML one at the end of
 * the chain - and "file too big" has to mean the same thing in both. */
function classifyUploadError(err, copy) {
  if (!err) return null;
  if (err.code === "LIMIT_FILE_SIZE") {
    const cap = MEDIA_ENABLED ? Math.max(IMAGE_LIMIT, MEDIA_LIMIT) : IMAGE_LIMIT;
    return {
      status: 413,
      message: copy.fileTooLarge
        .replace("{size}", copy.fileTooLargeUnknownSize)
        .replace("{limit}", `${Math.round(cap / MB)}MB`)
    };
  }
  // fileFilter rejections are plain Errors carrying one of our own strings,
  // in either language - compare against both rather than the caller's.
  const rejections = [i18n.en.onlyImages, i18n.en.onlyMedia, i18n.sl.onlyImages, i18n.sl.onlyMedia];
  if (rejections.includes(err.message)) return { status: 415, message: err.message };
  return null;
}

/** Turns the browser's captured video frame into bytes we are willing to
 * store, or null.
 *
 * A grid tile is an <img>, so a video post needs a still or it renders as
 * a broken-image icon. The frame is grabbed client-side at upload time
 * because the web server has no ffmpeg and adding it would roughly double
 * the image for one thumbnail. Uploads that do not send one - the app,
 * anything without JS - simply get a typed placeholder instead.
 *
 * Treated as hostile input: it arrives as a form field from the client,
 * so the size is capped and the JPEG magic bytes are checked rather than
 * trusting the data: prefix. */
const POSTER_MAX_BYTES = 512 * 1024;

function decodePoster(value) {
  if (typeof value !== "string" || !value.startsWith("data:image/jpeg;base64,")) return null;
  const base64 = value.slice("data:image/jpeg;base64,".length);
  // Reject before allocating: base64 is 4 bytes per 3, so this bounds the
  // decoded size without decoding first.
  if (base64.length > Math.ceil(POSTER_MAX_BYTES / 3) * 4) return null;
  let bytes;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    return null;
  }
  if (!bytes.length || bytes.length > POSTER_MAX_BYTES) return null;
  // SOI marker. A base64 string that decodes to something else is not a
  // JPEG no matter what the prefix claimed.
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  return bytes;
}

/** Poster objects sit beside their video under the same base name, using
 * the same `.infix` trick the raw originals used: the /uploads proxy's
 * validator allows no slashes, so a folder prefix is not an option. */
function posterKeyFor(filename) {
  const ext = path.extname(filename);
  return `${filename.slice(0, -ext.length)}.poster.jpg`;
}

function isMediaEnabled() {
  return MEDIA_ENABLED;
}

/** The `accept` attribute for the file input, so the picker offers only
 * what the server will actually take. */
function acceptAttribute() {
  return allowedMimes().join(",");
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    // The original name is client controlled, so it must never choose the
    // stored extension. The accepted MIME type maps to the only valid one.
    const ext = EXT_BY_MIME[file.mimetype] || "";
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`);
  }
});

const upload = multer({
  storage,
  // One ceiling for everything, necessarily the largest one allowed.
  // oversizeMessage() applies the real per-type limit afterwards.
  limits: { fileSize: MEDIA_ENABLED ? Math.max(IMAGE_LIMIT, MEDIA_LIMIT) : IMAGE_LIMIT },
  fileFilter: (req, file, cb) => {
    if (allowedMimes().includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    const lang = req.query?.lang === "sl" || req.session?.lang === "sl" ? "sl" : "en";
    cb(new Error(MEDIA_ENABLED ? i18n[lang].onlyMedia : i18n[lang].onlyImages));
  }
});

/** Images only, held to the image ceiling at the door.
 *
 * Marketplace photos use this rather than `upload` above: with media on,
 * that one accepts a 500MB video and only applies the image limit after
 * the whole file is already on disk. A listing has no use for a video, so
 * this rejects one before a byte of it is written. */
const imageUpload = multer({
  storage,
  limits: { fileSize: IMAGE_LIMIT },
  fileFilter: (req, file, cb) => {
    if (IMAGE_MIMES.includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    const lang = req.query?.lang === "sl" || req.session?.lang === "sl" ? "sl" : "en";
    cb(new Error(i18n[lang].onlyImages));
  }
});

module.exports = { uploadsPaused, upload, imageUpload, kindForMime, isMediaEnabled, acceptAttribute, oversizeMessage, classifyUploadError, decodePoster, posterKeyFor, POSTER_MAX_BYTES, IMAGE_LIMIT, MEDIA_LIMIT };
