/**
 * Handing video and audio off to a machine that can actually encode it.
 *
 * The web server never transcodes. It stores the original in object
 * storage, writes a job row, and marks the post as processing; a worker
 * elsewhere picks the job up. This is not a preference - benchmarking on
 * the Pi found the hardware encoder broken and software x264 at roughly
 * 1.2x realtime on synthetic input, and a heavier clip drove the machine
 * into swap until it rebooted and took the site down with it.
 *
 * With TRANSCODE_ENABLED unset, uploads behave exactly as before: the file
 * is served as it arrived. That keeps the site working with no worker
 * running at all, which matters because the worker is expected to live on
 * a machine that is not always on.
 */
const path = require("path");

const { statements } = require("./db");

/** Originals sit beside the finished file under the same base name with a
 * `.raw` infix - `1787-ab.raw.mp4` next to `1787-ab.mp4`.
 *
 * A `raw/` folder prefix would have been the obvious choice, but the
 * filename travels through the /uploads proxy's validator, which allows
 * no slashes. Same bucket, no new configuration, no path handling. */
function rawKeyFor(filename) {
  const ext = path.extname(filename);
  return `${filename.slice(0, -ext.length)}.raw${ext}`;
}

function isEnabled() {
  return process.env.TRANSCODE_ENABLED === "true";
}

/** True when this upload should be queued rather than served directly. */
function shouldQueue(kind) {
  return isEnabled() && (kind === "video" || kind === "audio");
}

/** Marks the post as processing and queues the work.
 *
 * Never throws: a queueing failure must not fail an upload that has
 * already been stored. The post simply stays 'ready' and serves whatever
 * was uploaded, which is the pre-transcoding behaviour and a perfectly
 * acceptable outcome.
 */
async function enqueue({ postId, filename, kind }) {
  try {
    await statements.insertMediaJob.run(postId, rawKeyFor(filename), kind);
    await statements.setMediaStatus.run(postId, "processing");
    return true;
  } catch (err) {
    console.error(`[media] could not queue post #${postId}: ${err.message}`);
    return false;
  }
}

module.exports = { isEnabled, shouldQueue, enqueue, rawKeyFor };
