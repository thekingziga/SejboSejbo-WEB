/**
 * The safety log: which address, browser or app, and device sent each
 * post, comment and listing - including the ones that were refused. It
 * exists for one job, finding and stopping whoever is abusing the site,
 * so it is only ever shown in /admin and is deleted after RETENTION_DAYS.
 *
 * Bans hang off the same identifiers: an address or a device on the ban
 * list cannot post, comment or list until it is lifted.
 */
const { statements } = require("./db");
const { getClientIp } = require("./ip");

const RETENTION_DAYS = 30;

/** An IPv4 address arrives as ::ffff:1.2.3.4 on a dual-stack socket. */
function cleanIp(ip) {
  return String(ip || "").replace(/^::ffff:/, "") || null;
}

/** Everything worth knowing about the sender, taken once per request. */
function who(req, { deviceId = null, userId = null } = {}) {
  return {
    ip: cleanIp(getClientIp(req)),
    userAgent: String(req.headers["user-agent"] || "").slice(0, 300) || null,
    deviceId: deviceId ? String(deviceId).slice(0, 128) : null,
    userId: userId || null,
    lang: String(req.headers["accept-language"] || "").split(",")[0].slice(0, 20) || null
  };
}

/** Never throws: a log write must not fail or slow the thing it records. */
async function record(sender, { kind, targetId = null, outcome }) {
  if (!sender) return;
  try {
    await statements.insertSafety.run(kind, targetId, outcome, sender.ip, sender.userAgent, sender.deviceId, sender.userId, sender.lang);
  } catch (err) {
    console.error(`[safety] could not record ${kind} ${targetId ?? ""}: ${err.message}`);
  }
}

function keysOf(sender) {
  return [sender.ip && `ip:${sender.ip}`, sender.deviceId && `device:${sender.deviceId}`].filter(Boolean);
}

/** The ban that applies to this sender, or null. */
async function bannedKey(sender) {
  const keys = keysOf(sender);
  if (!keys.length) return null;
  return (await statements.bannedKey.get(keys))?.key || null;
}

async function ban(key, reason) {
  if (!/^(ip|device):.{1,128}$/.test(String(key))) return false;
  await statements.insertBan.run(key, String(reason || "").slice(0, 200) || null);
  return true;
}

async function unban(key) {
  await statements.deleteBan.run(String(key));
}

async function purge() {
  try {
    await statements.purgeSafety.run(RETENTION_DAYS);
  } catch (err) {
    console.error(`[safety] purge failed: ${err.message}`);
  }
}

module.exports = { who, record, bannedKey, ban, unban, purge, RETENTION_DAYS };
