/**
 * Checks an upload before it is published. Two layers, because each one
 * misses what the other sees:
 *
 * - A local nudity model (nsfwjs, MobileNetV2, on WebAssembly) scores
 *   frames sampled across the whole file. Free, private, ~25ms a frame,
 *   so it can afford to look at every second of a video - which matters,
 *   because the trick that got through was a harmless clip that cuts to
 *   porn in its last seconds.
 * - A vision model behind the site's AI provider looks at a grid of those
 *   frames plus the title, and judges what a nudity score cannot: gore,
 *   hate, harassment of a real person, and whether a video was simply
 *   downloaded from TikTok/Instagram/YouTube (watermarks, @handles,
 *   platform UI, end screens).
 *
 * The verdict is "clean" (publish), "hold" (save hidden for the admin) or
 * "reject" (refuse the upload). Only a repost is rejected outright - it is
 * the one call the uploader can act on, and it is not worth a review.
 * Anything the scan could not finish is held, never waved through: an
 * outage must not become a way in.
 */
const { spawn } = require("child_process");
const sharp = require("sharp");

const ai = require("./ai");

const FRAME = 384; // sampled frames are padded squares of this size
const CELL = 256; // one frame in the grid sent to the vision model
const MAX_FRAMES = 40;
const NSFW_HOLD = 0.8; // Porn or Hentai probability on any frame
const TOOL_TIMEOUT_MS = 60000;

// --- frames ------------------------------------------------------------------

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TOOL_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 200)}`));
    });
  });
}

async function probe(filePath) {
  const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:format_tags", "-of", "json", filePath]);
  const format = JSON.parse(out.toString()).format || {};
  return { duration: Number(format.duration) || 0, tags: format.tags || {} };
}

/** Frames spread over the whole clip as raw RGB squares. Short clips are
 * decoded in full; long ones only at keyframes, so a ten-minute video
 * costs seconds rather than a full decode. */
async function videoFrames(filePath, duration) {
  const rate = Math.min(2, MAX_FRAMES / Math.max(duration, 1));
  const args = ["-v", "error"];
  if (duration > 60) args.push("-skip_frame", "nokey");
  args.push(
    "-i", filePath,
    "-vf", `fps=${rate.toFixed(4)},scale=${FRAME}:${FRAME}:force_original_aspect_ratio=decrease,pad=${FRAME}:${FRAME}:(ow-iw)/2:(oh-ih)/2`,
    "-frames:v", String(MAX_FRAMES),
    "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"
  );
  const raw = await run("ffmpeg", args);
  const size = FRAME * FRAME * 3;
  const frames = [];
  for (let at = 0; at + size <= raw.length; at += size) frames.push(raw.subarray(at, at + size));
  if (!frames.length) throw new Error("no frames decoded");
  return frames;
}

async function imageFrame(filePath) {
  return sharp(filePath)
    .rotate()
    .resize(FRAME, FRAME, { fit: "contain", background: { r: 0, g: 0, b: 0 } })
    .removeAlpha()
    .raw()
    .toBuffer();
}

const rawInput = { raw: { width: FRAME, height: FRAME, channels: 3 } };

// --- local nudity model ------------------------------------------------------

let modelPromise = null;

/** Loaded once, on first use or at startup. A failed load is forgotten so
 * the next upload tries again instead of the site scanning blind forever. */
function loadModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      const tf = require("@tensorflow/tfjs");
      require("@tensorflow/tfjs-backend-wasm");
      await tf.setBackend("wasm");
      await tf.ready();
      const nsfw = require("nsfwjs");
      return { tf, model: await nsfw.load("MobileNetV2Mid") };
    })();
    modelPromise.catch((err) => {
      console.error(`[moderation] nudity model failed to load: ${err.message}`);
      modelPromise = null;
    });
  }
  return modelPromise;
}

/** The worst frame's Porn/Hentai probability. Yields between frames: the
 * model runs on the main thread, and 40 frames back to back would freeze
 * every other request for a second. */
async function nudityScore(frames) {
  const { tf, model } = await loadModel();
  let worst = { score: 0, index: 0 };
  for (let i = 0; i < frames.length; i += 1) {
    const pixels = await sharp(frames[i], rawInput).resize(224, 224, { fit: "fill" }).raw().toBuffer();
    const image = tf.tensor3d(new Uint8Array(pixels), [224, 224, 3], "int32");
    const predictions = await model.classify(image, 5);
    image.dispose();
    const score = Math.max(...predictions.filter((p) => p.className === "Porn" || p.className === "Hentai").map((p) => p.probability), 0);
    if (score > worst.score) worst = { score, index: i };
    await new Promise((resolve) => setImmediate(resolve));
  }
  return worst;
}

/** Up to nine frames in a 3x3 grid, always including the last one (where
 * platform end screens are) and the frame the nudity model liked least. */
async function contactSheet(frames, extraIndex) {
  const picks = new Set([0, frames.length - 1, extraIndex]);
  for (let i = 1; picks.size < Math.min(9, frames.length); i += 1) {
    picks.add(Math.round((i * (frames.length - 1)) / 8) % frames.length);
  }
  const chosen = [...picks].sort((a, b) => a - b).slice(0, 9);
  const columns = Math.min(3, chosen.length);
  const rows = Math.ceil(chosen.length / columns);
  const cells = await Promise.all(chosen.map((i) => sharp(frames[i], rawInput).resize(CELL, CELL).jpeg().toBuffer()));
  return sharp({ create: { width: columns * CELL, height: rows * CELL, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite(cells.map((input, n) => ({ input, left: (n % columns) * CELL, top: Math.floor(n / columns) * CELL })))
    .jpeg({ quality: 80 })
    .toBuffer();
}

// --- the vision model --------------------------------------------------------

const RULES = `- sexual: nudity, sex acts or pornography anywhere, including drawings or cartoons that show genitals or sex. Shirtless people or swimwear alone are not sexual.
- gore: real graphic violence, serious injury, blood or death.
- hateful: hate symbols, slurs, or content attacking a group of people.
- harassing: it targets a specific real person with sexual claims or degrading lies (for example pretending to be someone's relative looking for a partner). Friendly jokes and nicknames are fine.`;

const REPOST_RULE = `- repost: the video was downloaded from another social network rather than filmed or made by the uploader. Evidence: a TikTok/Instagram/YouTube/Snapchat/Facebook/X/Twitch/Reddit logo or watermark, an @username or creator watermark (including small corner watermarks of edit or meme accounts), the platform's UI (like/comment/share buttons), or a platform end screen. Film or TV clips carrying an editor's watermark are reposts. A plain screen recording of a game or app, or the uploader's own phone footage, is NOT a repost.
- repost_source: the platform or account you saw, else null.`;

function promptFor({ kind, hasImage, title, description }) {
  const what = !hasImage
    ? "a text post"
    : kind === "video"
      ? "a grid of frames sampled across one uploaded video, in order (left to right, top to bottom)"
      : "one uploaded image (an animated GIF is shown as a grid of its frames)";
  const fields = kind === "video"
    ? '{"sexual": bool, "gore": bool, "hateful": bool, "harassing": bool, "repost": bool, "repost_source": string or null, "reason": string}'
    : '{"sexual": bool, "gore": bool, "hateful": bool, "harassing": bool, "reason": string}';
  return `You moderate uploads for sejbosejbo.fyi, a small Slovenian meme site where friends post their own photos, videos and memes. Titles are often in Slovenian.
You are given ${what}.
Title: ${JSON.stringify(title)}
Description: ${JSON.stringify(description || "")}

Answer ONLY with JSON: ${fields}

${RULES}
${kind === "video" ? REPOST_RULE : ""}
- reason: one short sentence in English.`;
}

// --- the verdict -------------------------------------------------------------

/** TikTok writes the clip's id into the comment tag of every download. */
function tiktokTag(tags) {
  return Object.values(tags).some((value) => /^vid:v[0-9a-z]{10,}/i.test(String(value)));
}

const clean = { verdict: "clean", reason: null };
const hold = (reason) => ({ verdict: "hold", reason });
const reject = (code, reason) => ({ verdict: "reject", code, reason });

/** @returns {{verdict: "clean"|"hold"|"reject", reason: string|null, code?: string}} */
async function scanUpload({ filePath, mimetype, kind, title, description }) {
  const hasImage = Boolean(filePath) && kind !== "audio";
  let sheet = null;
  let held = null;

  if (hasImage) {
    let frames;
    let tags = {};
    try {
      if (kind === "video" || mimetype === "image/gif") {
        const info = await probe(filePath);
        tags = info.tags;
        frames = await videoFrames(filePath, info.duration);
      } else {
        frames = [await imageFrame(filePath)];
      }
    } catch (err) {
      // Includes a file whose declared type is a lie - a video sent as a
      // JPEG does not decode as one.
      console.error(`[moderation] could not read ${filePath}: ${err.message}`);
      return hold("The file could not be checked automatically.");
    }

    if (kind === "video" && tiktokTag(tags)) return reject("repost", "TikTok download (metadata)");

    let worstIndex = 0;
    try {
      const worst = await nudityScore(frames);
      worstIndex = worst.index;
      if (worst.score >= NSFW_HOLD) held = hold(`Nudity model: ${Math.round(worst.score * 100)}% on frame ${worst.index + 1} of ${frames.length}.`);
    } catch (err) {
      held = hold("The nudity model is unavailable.");
      console.error(`[moderation] nudity check failed: ${err.message}`);
    }
    sheet = frames.length === 1
      ? await sharp(frames[0], rawInput).jpeg({ quality: 85 }).toBuffer()
      : await contactSheet(frames, worstIndex);
  }

  if (!ai.canModerate()) {
    // No hosted model configured (a dev machine, a fresh install): the
    // local check is all there is, and the site works without the rest.
    return held || clean;
  }

  let answer;
  try {
    answer = await ai.moderate(promptFor({ kind, hasImage, title, description }), sheet);
  } catch (err) {
    if (err.code === "content_policy") return held || hold("The AI provider refused to look at it (explicit content).");
    console.error(`[moderation] vision check failed: ${err.message}`);
    return held || hold("The AI check is unavailable.");
  }

  if (kind === "video" && answer.repost === true) {
    return reject("repost", String(answer.repost_source || answer.reason || "another social network").slice(0, 120));
  }
  const flags = ["sexual", "gore", "hateful", "harassing"].filter((flag) => answer[flag] === true);
  if (flags.length) return hold(`AI: ${flags.join(", ")} - ${String(answer.reason || "").slice(0, 200)}`);
  return held || clean;
}

/** Warms the nudity model at startup, so the first upload after a deploy
 * does not pay the three-second load. */
function warmUp() {
  loadModel().catch(() => {});
}

module.exports = { scanUpload, warmUp, _internal: { tiktokTag, promptFor } };
