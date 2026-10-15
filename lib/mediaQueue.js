/**
 * Shrinking large videos later, without making anyone wait.
 *
 * The web server never transcodes. Benchmarking on the Pi found the
 * hardware encoder broken and software x264 at roughly 1.2x realtime, and
 * a heavier clip drove the machine into swap until it rebooted and took
 * the site down. So encoding happens on a worker elsewhere.
 *
 * What that worker does NOT do any more is stand between an upload and it
 * being watchable. The file is stored under its real name and the post is
 * playable the moment the upload finishes; a job is only queued to make it
 * smaller afterwards, and the worker overwrites the same key when it has
 * something better. Every failure mode therefore ends with the original
 * still playing, which is why there is no fallback path left to get wrong.
 *
 * With TRANSCODE_ENABLED unset, nothing is queued at all.
 */
const { statements } = require("./db");

/** Only videos above this are worth the trouble. Anything smaller is
 * already fine to serve and encoding it would cost more than it saves. */
const MIN_BYTES = Number(process.env.TRANSCODE_MIN_MB || 100) * 1024 * 1024;

function isEnabled() {
  return process.env.TRANSCODE_ENABLED === "true";
}

/** True when this upload is worth shrinking later.
 *
 * Video only. Audio is left alone deliberately: re-encoding it means
 * changing the container - .mp3 in, .m4a out - and the post row already
 * points at the uploaded name, so it would need a rename the /uploads
 * proxy and every cached link would have to follow. Audio is capped at
 * the same 500MB as video and is rarely anywhere near it.
 */
function shouldQueue(kind, sizeBytes) {
  return isEnabled() && kind === "video" && Number(sizeBytes) > MIN_BYTES;
}

/** Queues the shrink. The post is already live and playable.
 *
 * Never throws: a queueing failure must not fail an upload that has
 * already been stored and is already working. The post simply keeps
 * serving the file at its original size, which is a perfectly acceptable
 * outcome and exactly what happens with no worker running.
 */
async function enqueue({ postId, filename, kind }) {
  try {
    // The job points at the live key, not a separate original. The worker
    // replaces it in place, so media_status stays 'ready' throughout -
    // there is no window where the post is unplayable.
    await statements.insertMediaJob.run(postId, filename, kind);
    return true;
  } catch (err) {
    console.error(`[media] could not queue post #${postId}: ${err.message}`);
    return false;
  }
}

module.exports = { isEnabled, shouldQueue, enqueue, MIN_BYTES };
