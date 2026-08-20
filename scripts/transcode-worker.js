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
const os = require("os");
const path = require("path");

const { statements, pool } = require("../lib/db");
const storage = require("../lib/storage");
const { rawKeyFor } = require("../lib/mediaQueue");

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const POLL_MS = Number(process.env.WORKER_POLL_MS || 5000);
const MAX_ATTEMPTS = Number(process.env.WORKER_MAX_ATTEMPTS || 3);
const STALE_SECONDS = Number(process.env.WORKER_STALE_SECONDS || 1800);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

// Encoding targets. Deliberately modest: this is a meme site, not a
// streaming service, and every one of these is a knob someone will want
// to turn without editing code.
const MAX_HEIGHT = Number(process.env.TRANSCODE_MAX_HEIGHT || 720);
const CRF = Number(process.env.TRANSCODE_CRF || 27);
const PRESET = process.env.TRANSCODE_PRESET || "veryfast";
const AUDIO_BITRATE = process.env.TRANSCODE_AUDIO_BITRATE || "96k";
const THREADS = Number(process.env.TRANSCODE_THREADS || 0); // 0 = ffmpeg decides

// Hard ceilings. A clip longer than this is rejected rather than encoded:
// an hour of video on a home machine is not a queue, it is a hostage
// situation.
const MAX_DURATION_S = Number(process.env.TRANSCODE_MAX_DURATION || 180);
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
    await fsp.writeFile(input, Buffer.from(await res.arrayBuffer()));

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

    // The post already points at this name, so writing it is what makes
    // the video appear. Mirror too, if one is configured.
    const bytes = await fsp.readFile(output);
    const finalName = job.source_key.replace(/\.raw(\.[^.]+)$/, job.kind === "audio" ? ".m4a" : "$1");
    await storage._internal.s3Put(finalName, bytes, storage._internal.S3);
    if (storage._internal.bucketConfigured(storage._internal.MIRROR)) {
      try {
        await storage._internal.s3Put(finalName, bytes, storage._internal.MIRROR);
      } catch (err) {
        log(`job ${job.id}: mirror write failed (not fatal): ${err.message}`);
      }
    }

    await statements.setMediaStatus.run(job.post_id, "ready");
    await statements.finishMediaJob.run(job.id);

    // Only now is the original expendable. Deleting it earlier would mean
    // a failed retry had nothing to retry from.
    try {
      await storage.remove(job.source_key);
    } catch (err) {
      log(`job ${job.id}: could not remove original (harmless): ${err.message}`);
    }
    log(`job ${job.id}: done, post #${job.post_id} is ready`);
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
}

/** Last resort when a job will never succeed.
 *
 * The post points at `<name>.<ext>`, which only exists once an encode has
 * written it - so leaving the post 'ready' with nothing there gives every
 * visitor a broken player. Promote the untouched original to that name
 * instead: the post plays, it just never got made smaller. Only then is
 * the raw copy expendable.
 */
async function giveUp(job) {
  const finalName = job.source_key.replace(/\.raw(\.[^.]+)$/, "$1");
  try {
    const res = await storage.getObject(job.source_key);
    if (!res.ok) throw new Error(`original missing (HTTP ${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    await storage._internal.s3Put(finalName, bytes, storage._internal.S3);
    if (storage._internal.bucketConfigured(storage._internal.MIRROR)) {
      try {
        await storage._internal.s3Put(finalName, bytes, storage._internal.MIRROR);
      } catch (err) {
        log(`job ${job.id}: mirror write failed while giving up: ${err.message}`);
      }
    }
    await statements.setMediaStatus.run(job.post_id, "ready");
    await storage.remove(job.source_key).catch(() => {});
    log(`job ${job.id}: gave up encoding, serving the original unchanged`);
  } catch (err) {
    // Nothing playable to offer, so stop claiming the post is ready.
    await statements.setMediaStatus.run(job.post_id, "failed");
    log(`job ${job.id}: could not fall back to the original: ${err.message}`);
  }
}

async function tick() {
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
    log(`job ${job.id} failed (attempt ${job.attempts}/${MAX_ATTEMPTS}) -> ${row?.status}: ${err.message}`);
    if (row?.status === "failed") await giveUp(job);
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
