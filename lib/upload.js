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
    // Pasted screenshots commonly arrive as "image.png" with no extension
    // survivable through originalname, or none at all - fall back to the
    // MIME type so the file still lands with a sane extension.
    let ext = path.extname(file.originalname || "").toLowerCase();
    if (!ext) ext = EXT_BY_MIME[file.mimetype] || "";
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

module.exports = { upload, kindForMime, isMediaEnabled, acceptAttribute, oversizeMessage, classifyUploadError, IMAGE_LIMIT, MEDIA_LIMIT };
