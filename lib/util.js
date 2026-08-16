const crypto = require("crypto");

/** Timezone the site presents itself in. Slovenia by default, since that is
 * where it is written, hosted and read.
 *
 * This governs what a *human* sees: post timestamps on the page, and which
 * calendar day the Sejbometer counts as "today". It deliberately does NOT
 * govern the JSON API, whose created_at stays ISO-8601 UTC - that is a
 * documented contract the app parses, and shifting it would silently move
 * every date the app displays. */
const SITE_TZ = process.env.SITE_TIMEZONE || "Europe/Ljubljana";

const i18n = require("./i18n");
const { statements } = require("./db");

function getLang(req) {
  const queryLang = req.query?.lang;
  if (queryLang === "sl" || queryLang === "en") return queryLang;
  return req.session?.lang === "sl" ? "sl" : "en";
}

function getCopy(req) {
  return i18n[getLang(req)];
}

function withLang(req, url) {
  const lang = getLang(req);
  return `${url}${url.includes("?") ? "&" : "?"}lang=${lang}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function daysSince(value) {
  const then = toDate(value);
  if (!then) return null;
  return Math.max(0, Math.floor((Date.now() - then.getTime()) / 86400000));
}

/** Normalises whatever the database hands back into a Date.
 *
 * Postgres returns timestamptz as a real Date object, already correct.
 * SQLite returned "YYYY-MM-DD HH:MM:SS" - UTC, but with no marker saying
 * so, which had to be tagged with a Z or it would be read as local time.
 *
 * Doing the string trick to a Date is what broke this during the Postgres
 * migration: `${dateObject}Z` stringifies to local time ("... GMT+0200")
 * and then claims it is UTC, shifting every timestamp on the site by the
 * server's offset. Both shapes are handled explicitly here so neither
 * database can be misread. */
function toDate(value) {
  if (value instanceof Date) return value;
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(text);
  const date = new Date(hasZone ? text : `${text.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = toDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: SITE_TZ
  }).format(date);
}

/** SQLite stores CURRENT_TIMESTAMP as "YYYY-MM-DD HH:MM:SS" UTC with no
 * offset marker; append Z before handing it to Date so it isn't
 * misinterpreted as local time. */
function toIsoUtc(value) {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

async function getTotalVisits() {
  return (await statements.totalVisits.get()).value;
}

/** Today's award. Prefers the AI's pick when there is a fresh one for
 * today, otherwise the original deterministic date-hash choice - which is
 * also what runs whenever Ollama is off, hasn't caught up yet, or picked a
 * post that has since been hidden or deleted. Required lazily so lib/ai.js
 * can keep depending on this module without a cycle. */
async function getDailyUpload() {
  const aiPick = await require("./ai").getDailyAwardPost();
  if (aiPick) return aiPick;

  // COUNT + OFFSET rather than loading every visible row into memory to
  // pick one. This runs on every page render, so the old version read the
  // whole archive - fine at 30 posts, quadratically annoying at 5000.
  const total = (await statements.countVisible.get()).count;
  if (!total) return null;
  const stamp = new Date().toISOString().slice(0, 10);
  const hash = crypto.createHash("sha1").update(stamp).digest();
  // Two bytes, so the spread doesn't collapse once the archive passes 256.
  const index = ((hash[0] << 8) | hash[1]) % total;
  return (await statements.dailyPick.get(index)) || null;
}

/** Origin the app/browser should use to build absolute URLs (image_url,
 * og:image). TLS is terminated upstream (HAProxy), so Node only ever sees
 * plain HTTP - trust the proxy's forwarded proto rather than req.protocol,
 * which would otherwise report http and produce broken https:// URLs. */
function getOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers.host || "sejbosejbo.fyi";
  return `${proto}://${host}`;
}

module.exports = {
  SITE_TZ,
  getLang,
  getCopy,
  withLang,
  escapeHtml,
  daysSince,
  formatDate,
  toIsoUtc,
  getTotalVisits,
  getDailyUpload,
  getOrigin
};
