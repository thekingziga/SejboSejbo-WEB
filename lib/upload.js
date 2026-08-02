const crypto = require("crypto");
const path = require("path");

const multer = require("multer");

const i18n = require("./i18n");
const { uploadDir } = require("./db");

const EXT_BY_MIME = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp"
};

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
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    const lang = req.query?.lang === "sl" || req.session?.lang === "sl" ? "sl" : "en";
    cb(new Error(i18n[lang].onlyImages));
  }
});

module.exports = { upload };
