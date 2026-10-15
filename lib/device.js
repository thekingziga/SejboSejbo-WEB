/**
 * Device identity for votes.
 *
 * A vote is attributed to whatever the client puts in X-Device-Id. That
 * header is just a string the client chooses, so a few lines of script
 * that send a fresh random id per request could vote as many times as the
 * per-IP rate limit allowed - 60 a minute, or 86,400 a day, against a
 * site whose entire history is a few hundred votes.
 *
 * Two defences here, and they work at different levels:
 *
 * 1. Signed ids. The server mints them and HMACs them, so a client can no
 *    longer invent one. This stops the trivial attack. It does NOT stop
 *    someone who simply asks for a thousand ids - which is why:
 *
 * 2. A cap on how many DISTINCT devices one address may vote from per
 *    hour. That is the measure that actually costs an attacker something,
 *    because it holds whether the ids are signed, minted in bulk, or
 *    forged.
 *
 * Signing is enforced only when REQUIRE_SIGNED_DEVICE_ID is set. The
 * Flutter app generates its own ids and is already in testers' hands;
 * turning enforcement on before it ships an update would break voting for
 * every app user. The website mints signed ids from the start, so the
 * switch can be flipped once the app follows.
 */
const crypto = require("crypto");

const SECRET =
  process.env.DEVICE_ID_SECRET ||
  process.env.SESSION_SECRET ||
  crypto.randomBytes(32).toString("hex");

const PREFIX = "v1";
const MAX_DEVICES_PER_IP = Number(process.env.MAX_DEVICES_PER_IP || 20);
const DEVICE_WINDOW_MS = Number(process.env.DEVICE_WINDOW_MS || 60 * 60 * 1000);

const SIGNATURE_LENGTH = 32;

function sign(body) {
  return crypto.createHmac("sha256", SECRET).update(body).digest("base64url").slice(0, SIGNATURE_LENGTH);
}

/** Shape stays inside the existing DEVICE_ID_RE ([A-Za-z0-9_-]{8,128}),
 * so signed ids travel through every path that already handled the old
 * UUIDs without any of them needing to know the difference. */
function mintDeviceId() {
  const body = `${PREFIX}_${crypto.randomBytes(18).toString("base64url")}`;
  return `${body}_${sign(body)}`;
}

/** Splits at a FIXED offset from the end, never on the last "_".
 *
 * Both halves are base64url, whose alphabet includes "_" and "-", so
 * searching for a separator character lands inside the signature roughly
 * two times in five - which made this reject its own valid ids,
 * intermittently, depending on the random bytes. The signature is always
 * exactly SIGNATURE_LENGTH characters, so position is the only reliable
 * way to divide them. */
function isSignedDeviceId(value) {
  if (typeof value !== "string" || !value.startsWith(`${PREFIX}_`)) return false;
  const index = value.length - SIGNATURE_LENGTH - 1;
  if (index <= PREFIX.length || value[index] !== "_") return false;
  const body = value.slice(0, index);
  const given = Buffer.from(value.slice(index + 1));
  const wanted = Buffer.from(sign(body));
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

function signingRequired() {
  return process.env.REQUIRE_SIGNED_DEVICE_ID === "true";
}

/** True when this id may cast a vote. With enforcement off, an unsigned
 * id is still accepted - the distinct-device cap below is what limits it. */
function deviceIdAcceptable(value) {
  return signingRequired() ? isSignedDeviceId(value) : true;
}

// --- distinct devices per address -------------------------------------------

/** ip -> Map(deviceId -> last seen). Bounded by pruning on read and by a
 * periodic sweep, so a stream of one-shot addresses can't grow it without
 * limit. */
const seen = new Map();

setInterval(() => {
  const cutoff = Date.now() - DEVICE_WINDOW_MS;
  for (const [ip, devices] of seen) {
    for (const [id, at] of devices) if (at <= cutoff) devices.delete(id);
    if (devices.size === 0) seen.delete(ip);
  }
}, Math.min(DEVICE_WINDOW_MS, 10 * 60 * 1000)).unref();

/** Registers a device against an address.
 *
 * Returns { ok: true } when the device may proceed, or { ok: false,
 * retryAfter } when this address has already used too many distinct
 * devices within the window.
 *
 * The limit is deliberately generous. Slovenian mobile carriers put many
 * real subscribers behind one CGNAT address, so a tight cap would lock
 * out genuine visitors who happen to share an IP with each other. Twenty
 * distinct devices an hour from one address is far beyond anything this
 * site sees honestly, and far below what makes scripted voting worth the
 * effort.
 */
function registerDevice(ip, deviceId) {
  const now = Date.now();
  const cutoff = now - DEVICE_WINDOW_MS;
  let devices = seen.get(ip);
  if (!devices) {
    devices = new Map();
    seen.set(ip, devices);
  }
  for (const [id, at] of devices) if (at <= cutoff) devices.delete(id);

  // Already-known device: refresh it and let it through. Someone voting
  // repeatedly from one device is handled by the per-post UNIQUE
  // constraint, not by this.
  if (devices.has(deviceId)) {
    devices.set(deviceId, now);
    return { ok: true };
  }

  if (devices.size >= MAX_DEVICES_PER_IP) {
    const oldest = Math.min(...devices.values());
    return { ok: false, retryAfter: Math.max(1, Math.ceil((oldest + DEVICE_WINDOW_MS - now) / 1000)) };
  }

  devices.set(deviceId, now);
  return { ok: true };
}

/** Test seam - the limiter is process-global module state otherwise. */
function _reset() {
  seen.clear();
}

module.exports = {
  mintDeviceId,
  isSignedDeviceId,
  deviceIdAcceptable,
  signingRequired,
  registerDevice,
  MAX_DEVICES_PER_IP,
  _reset
};
