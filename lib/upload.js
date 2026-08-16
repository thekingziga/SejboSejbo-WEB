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

const IMAGE_LIMIT = 8 * 1024 * 1024;
const MEDIA_LIMIT = 64 * 1024 * 1024;

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
  // multer applies one limit to every file, so with media on this has to
  // be the video ceiling. The per-type check below keeps images at 8MB.
  limits: { fileSize: MEDIA_ENABLED ? MEDIA_LIMIT : IMAGE_LIMIT },
  fileFilter: (req, file, cb) => {
    if (allowedMimes().includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    const lang = req.query?.lang === "sl" || req.session?.lang === "sl" ? "sl" : "en";
    cb(new Error(MEDIA_ENABLED ? i18n[lang].onlyMedia : i18n[lang].onlyImages));
  }
});

module.exports = { upload, kindForMime, isMediaEnabled, acceptAttribute, IMAGE_LIMIT };
