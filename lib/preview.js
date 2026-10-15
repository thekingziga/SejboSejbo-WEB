/**
 * Social share images.
 *
 * Every post used to share as the site logo, so a link dropped into a
 * group chat gave no hint which post it was. Now each post renders its
 * own card - but heavily blurred, with the logo on top, so the preview
 * says "there is a picture here" without giving the joke away. You have
 * to open the link to see it, which is the whole point of sharing it.
 *
 * Cards are 1200x630 (the size every scraper wants) and JPEG, because
 * some scrapers still refuse WebP.
 */
const fs = require("fs/promises");
const path = require("path");

const sharp = require("sharp");

const storage = require("./storage");
const { uploadDir } = require("./db");

const WIDTH = 1200;
const HEIGHT = 630;
// Enough that no detail survives at any zoom, but the colour blocking and
// rough composition still read as "a photo" rather than a grey rectangle.
const BLUR_SIGMA = 34;
const LOGO_WIDTH = 380;
const LOGO_PATH = path.join(__dirname, "..", "public", "logo.png");

// A hostile upload can be a "decompression bomb": a few KB of JPEG that
// expands to gigapixels and takes the process down with it. Uploads are
// already size-capped, but this is the specific defence for that trick.
const MAX_INPUT_PIXELS = 40 * 1024 * 1024;

/** Rendered cards, keyed by filename. Bounded so a large gallery can't
 * grow this without limit; oldest entry is evicted first (re-inserting on
 * every hit keeps the Map's insertion order as an LRU). */
const cache = new Map();
const CACHE_MAX = 96;

/** Scrapers hit hard and in parallel - Facebook, WhatsApp and Signal can
 * all fetch the same card within a second of each other. Without this,
 * each one starts its own sharp pipeline for identical output, which on a
 * Raspberry Pi is exactly the wrong way to spend the CPU. */
const inFlight = new Map();

let logoPromise = null;
function logoBuffer() {
  if (!logoPromise) {
    logoPromise = sharp(LOGO_PATH)
      .resize({ width: LOGO_WIDTH })
      .png()
      .toBuffer()
      .catch((err) => {
        // Don't cache the failure - a missing logo shouldn't permanently
        // disable previews for the rest of the process's life.
        logoPromise = null;
        throw err;
      });
  }
  return logoPromise;
}

/** Source bytes for a post's image: the object store when that's where
 * uploads live, otherwise local disk. Mirrors the fallback order used by
 * the /uploads proxy. */
async function sourceBytes(filename) {
  if (storage.isRemote()) {
    const res = await storage.getObject(filename);
    if (res.ok) return Buffer.from(await res.arrayBuffer());
  }
  try {
    return await fs.readFile(path.join(uploadDir, filename));
  } catch {
    return null;
  }
}

async function render(filename) {
  const bytes = await sourceBytes(filename);
  if (!bytes) return null;

  const base = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "none" })
    .rotate() // honour EXIF orientation, or portrait photos come out sideways
    .resize(WIDTH, HEIGHT, { fit: "cover", position: "attention" })
    .blur(BLUR_SIGMA)
    // Darkened so the logo stays legible over a bright photo.
    .modulate({ brightness: 0.72 })
    .toBuffer();

  return sharp(base)
    .composite([{ input: await logoBuffer(), gravity: "center" }])
    .jpeg({ quality: 82, progressive: true })
    .toBuffer();
}

/** Returns a JPEG Buffer, or null when the source image can't be found.
 * Never throws for an unreadable image - callers fall back to the logo. */
async function previewFor(filename) {
  if (!filename) return null;

  const hit = cache.get(filename);
  if (hit) {
    cache.delete(filename);
    cache.set(filename, hit);
    return hit;
  }

  const pending = inFlight.get(filename);
  if (pending) return pending;

  const job = render(filename)
    .then((buffer) => {
      if (buffer) {
        cache.set(filename, buffer);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      }
      return buffer;
    })
    .catch((err) => {
      console.error(`[preview] could not render ${filename}: ${err.message}`);
      return null;
    })
    .finally(() => inFlight.delete(filename));

  inFlight.set(filename, job);
  return job;
}

module.exports = { previewFor, WIDTH, HEIGHT };
