#!/usr/bin/env node
/**
 * Media transcoding worker.
 *
 * Runs on ANY machine that is not the web server: it needs ffmpeg, and
 * network access to Postgres and the object store. Nothing else. Several
 * can run at once on different machines with no coordination - claiming
 * uses FOR UPDATE SKIP LOCKED, so each takes a different job.
 *
 *   PGHOST=... PGUSER=... PGPASSWORD=... PGDATABASE=... \
 *   STORAGE_DRIVER=s3 S3_BUCKET=... S3_ENDPOINT=... \
 *   S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
 *   node scripts/transcode-worker.js
 *
 * The job loop is deliberately dull: claim one, encode it, write it back,
 * mark it done. One at a time, because the machine this lands on is
 * usually someone's desktop and a queue that saturates it is a queue that
 * gets turned off.
 *
 * Failure handling: a job that throws goes back to 'pending' for another
 * attempt, and is marked 'failed' once it has used up MAX_ATTEMPTS. A job
 * whose worker dies mid-encode is reclaimed by the next worker after
 * STALE_SECONDS, because nothing would otherwise release it.
 */
const { spawn } = require("child_process");
const fsp = require("fs/promises");
const fs = require("fs");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const os = require("os");
const path = require("path");

const { statements, pool } = require("../lib/db");
const storage = require("../lib/storage");

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const POLL_MS = Number(process.env.WORKER_POLL_MS || 5000);
const MAX_ATTEMPTS = Number(process.env.WORKER_MAX_ATTEMPTS || 3);
const STALE_SECONDS = Number(process.env.WORKER_STALE_SECONDS || 1800);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

// Encoding targets. The job is to save bandwidth on genuinely large
// uploads, not to squeeze every byte: nothing here waits on the encode any
// more, so there is no reason to trade picture quality for speed. 1080p at
// crf 23 with a slower preset is close to visually transparent on phone
// video while still typically halving the file, where the old 720p/crf 27
// was visibly soft.
const MAX_HEIGHT = Number(process.env.TRANSCODE_MAX_HEIGHT || 1080);
const CRF = Number(process.env.TRANSCODE_CRF || 23);
const PRESET = process.env.TRANSCODE_PRESET || "medium";
const AUDIO_BITRATE = process.env.TRANSCODE_AUDIO_BITRATE || "128k";

// How much smaller the result has to be before it is worth replacing the
// upload. Re-encoding something already efficient can produce a bigger
// file, and even a 2% win is not worth swapping a known-good original for
// a freshly generated one. 0.9 = must come in under 90% of the source.
const MIN_SAVING = Number(process.env.TRANSCODE_MIN_SAVING || 0.9);

// Encoding is deferred to the quiet hours. The machine also runs Immich
// and friends, and a 500MB encode competing with them at midday is the
// kind of thing that gets noticed; at 3am it is not. Local time, inclusive
// start and exclusive end, so 2-4 means 02:00:00 to 03:59:59.
const WINDOW_START = Number(process.env.TRANSCODE_WINDOW_START ?? 2);
const WINDOW_END = Number(process.env.TRANSCODE_WINDOW_END ?? 4);
const WINDOW_TZ = process.env.SITE_TIMEZONE || "Europe/Ljubljana";

/** Whether new jobs may be claimed right now. A job already in hand always
 * runs to completion - stopping mid-encode would waste the work and leave
 * a claimed row to time out. */
function insideWindow(now = new Date()) {
  // Same window regardless of where the container thinks it is.
  const hour = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: WINDOW_TZ, hour: "2-digit", hour12: false
  }).format(now));
  // A window that wraps midnight (22 to 4) is still one window.
  return WINDOW_START <= WINDOW_END
    ? hour >= WINDOW_START && hour < WINDOW_END
    : hour >= WINDOW_START || hour < WINDOW_END;
}
const THREADS = Number(process.env.TRANSCODE_THREADS || 0); // 0 = ffmpeg decides

// Hard ceiling, now a sanity guard rather than a queue policy. It used to
// be 180s because a post stayed unplayable until its encode finished, so a
// long clip held someone's upload hostage. Nothing waits any more - the
// video is already playing - and uploads are capped at 500MB, which bounds
// the real cost. A clip longer than this is left exactly as uploaded.
const MAX_DURATION_S = Number(process.env.TRANSCODE_MAX_DURATION || 3600);
// Wall-clock cap per job, after which ffmpeg is killed. Catches both a
// pathological input and an ffmpeg that has simply hung.
const JOB_TIMEOUT_MS = Number(process.env.TRANSCODE_TIMEOUT_MS || 20 * 60 * 1000);

let stopping = false;

function log(...args) {
  console.log(`[worker ${new Date().toISOString()}]`, ...args);
}

/** Runs a command, capturing stderr for the error message and killing it
 * if it outstays the timeout. */
function run(command, args, { timeoutMs = JOB_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    // Bounded: ffmpeg is chatty and a stuck job could otherwise grow this
    // until the worker itself runs out of memory.
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} exceeded ${Math.round(timeoutMs / 1000)}s and was killed`));
    }, timeoutMs);

    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr.split("\n").filter(Boolean).slice(-3).join(" | ")}`));
    });
  });
}

async function probeDuration(file) {
  const { stdout } = await run(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file
  ], { timeoutMs: 60000 });
  const seconds = Number(String(stdout).trim());
  return Number.isFinite(seconds) ? seconds : null;
}

function videoArgs(input, output) {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    ...(THREADS ? ["-threads", String(THREADS)] : []),
    "-i", input,
    // Only ever scale DOWN - `min(iw,...)` leaves an already-small clip
    // alone instead of upscaling it into a bigger file than it started.
    "-vf", `scale='min(iw,trunc(iw*${MAX_HEIGHT}/ih/2)*2)':'min(ih,${MAX_HEIGHT})'`,
    "-c:v", "libx264", "-preset", PRESET, "-crf", String(CRF),
    // yuv420p and +faststart are what make the result play on phones and
    // start before it has finished downloading.
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    "-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ac", "2",
    "-y", output
  ];
}

function audioArgs(input, output) {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-i", input,
    "-vn",
    "-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ac", "2",
    "-movflags", "+faststart",
    "-y", output
  ];
}

async function processJob(job) {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sejbo-"));
  const ext = path.extname(job.source_key) || ".mp4";
  const input = path.join(workDir, `in${ext}`);
  const outExt = job.kind === "audio" ? ".m4a" : ".mp4";
  const output = path.join(workDir, `out${outExt}`);

  try {
    log(`job ${job.id}: fetching ${job.source_key}`);
    const res = await storage.getObject(job.source_key);
    if (!res.ok) throw new Error(`source missing from storage (HTTP ${res.status})`);
    // Streamed to disk, never buffered: Buffer.from(await res.arrayBuffer())
    // held the entire source in memory, which at the 500MB ceiling is a
    // container kill rather than a transcode.
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(input));

    const duration = await probeDuration(input);
    if (duration !== null && duration > MAX_DURATION_S) {
      // Not retryable - a long clip will still be long next time.
      const err = new Error(`clip is ${Math.round(duration)}s, limit is ${MAX_DURATION_S}s`);
      err.permanent = true;
      throw err;
    }
    log(`job ${job.id}: encoding ${duration ? Math.round(duration) + "s" : "unknown length"} ${job.kind}`);

    const started = Date.now();
    await run(FFMPEG, job.kind === "audio" ? audioArgs(input, output) : videoArgs(input, output));
    const elapsed = (Date.now() - started) / 1000;

    const [before, after] = await Promise.all([fsp.stat(input), fsp.stat(output)]);
    log(
      `job ${job.id}: ${(before.size / 1048576).toFixed(1)}MB -> ${(after.size / 1048576).toFixed(1)}MB ` +
      `in ${elapsed.toFixed(1)}s${duration ? ` (${(duration / elapsed).toFixed(2)}x realtime)` : ""}`
    );

    // Refuse to make things worse. Re-encoding an already-efficient clip
    // can easily produce a LARGER file, and the whole point of the job is
    // to save bandwidth - so if the result is not meaningfully smaller,
    // the upload stays exactly as it is.
    if (after.size >= before.size * MIN_SAVING) {
      log(
        `job ${job.id}: keeping the original - re-encode was ` +
        `${(after.size / 1048576).toFixed(1)}MB against ${(before.size / 1048576).toFixed(1)}MB`
      );
      await statements.finishMediaJob.run(job.id);
      return;
    }

    // Overwrites the live key. The post has been playing this whole time
    // and keeps playing; it just gets smaller. Written to the primary
    // first, because that is what the site serves - a mirror failure here
    // leaves the two copies differing, which verify-media --repair fixes.
    const outBytesHash = await storage.sha256File(output);
    await storage.putFile(job.source_key, output, outBytesHash, after.size, storage._internal.S3);
    if (storage._internal.bucketConfigured(storage._internal.MIRROR)) {
      try {
        await storage.putFile(job.source_key, output, outBytesHash, after.size, storage._internal.MIRROR);
      } catch (err) {
        log(`job ${job.id}: mirror write failed (verify-media --repair will heal it): ${err.message}`);
      }
    }

    await statements.finishMediaJob.run(job.id);
    log(
      `job ${job.id}: post #${job.post_id} shrunk to ` +
      `${(after.size / 1048576).toFixed(1)}MB (${Math.round((1 - after.size / before.size) * 100)}% smaller)`
    );
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
}

async function tick() {
  // Outside the quiet hours there is nothing to do. Jobs simply wait -
  // every one of their posts is already playing.
  if (!insideWindow()) return false;

  const job = await statements.claimMediaJob.get(WORKER_ID, STALE_SECONDS, MAX_ATTEMPTS);
  if (!job) return false;

  try {
    await processJob(job);
  } catch (err) {
    // The threshold is compared against the row's own attempts column, so
    // passing 0 makes the condition always true - that is how a permanent
    // failure gives up at once. Passing MAX_ATTEMPTS here (the obvious
    // guess) instead retried an over-length clip three times to reach the
    // same conclusion.
    const threshold = err.permanent ? 0 : MAX_ATTEMPTS;
    const row = await statements.failMediaJob.get(job.id, String(err.message).slice(0, 500), threshold);
    // No fallback to write: the post has been serving the uploaded file
    // since the moment it was uploaded and carries on doing so. A failed
    // job costs a bigger file, nothing else.
    log(`job ${job.id} failed (attempt ${job.attempts}/${MAX_ATTEMPTS}) -> ${row?.status}, post #${job.post_id} keeps the original: ${err.message}`);
  }
  return true;
}

async function main() {
  if (!storage.isRemote()) {
    console.error("STORAGE_DRIVER is not 's3' (or the S3_* vars are incomplete). The worker reads and writes object storage only.");
    process.exit(1);
  }
  await run(FFMPEG, ["-version"], { timeoutMs: 15000 }).catch(() => {
    console.error(`ffmpeg not runnable as '${FFMPEG}'. Install it, or set FFMPEG_PATH.`);
    process.exit(1);
  });

  log(`started as ${WORKER_ID}`);
  log(`targets: <=${MAX_HEIGHT}p, crf ${CRF}, preset ${PRESET}, max ${MAX_DURATION_S}s per clip`);
  log(`encoding window: ${String(WINDOW_START).padStart(2, "0")}:00-${String(WINDOW_END).padStart(2, "0")}:00 ${WINDOW_TZ} (currently ${insideWindow() ? "open" : "closed"})`);

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      // Finish the job in hand rather than abandoning it half-encoded.
      log(`${signal} received, finishing the current job then stopping`);
      stopping = true;
    });
  }

  while (!stopping) {
    let didWork = false;
    try {
      didWork = await tick();
    } catch (err) {
      // The loop must survive anything - a dropped database connection
      // should mean a pause, not a dead worker.
      console.error(`[worker] loop error: ${err.message}`);
    }
    if (!didWork && !stopping) await new Promise((r) => setTimeout(r, POLL_MS));
  }

  await pool.end();
  log("stopped");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
