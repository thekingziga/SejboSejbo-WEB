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
const DEFAULT_SITE_URL = "https://sejbosejbo.fyi";

/** Canonical public origin. Never derive this from request Host headers: it
 * feeds payment redirects, API media URLs and sitemap entries. */
function publicOrigin() {
  const configured = process.env.SITE_URL || DEFAULT_SITE_URL;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported protocol");
    return url.origin;
  } catch {
    console.error(`[config] invalid SITE_URL ${JSON.stringify(configured)}; using ${DEFAULT_SITE_URL}`);
    return DEFAULT_SITE_URL;
  }
}

const PUBLIC_ORIGIN = publicOrigin();

const i18n = require("./i18n");
const { statements } = require("./db");

function getLang(req) {
  const queryLang = req.query?.lang;
  if (queryLang === "sl" || queryLang === "en") return queryLang;
  return req.session?.lang === "sl" ? "sl" : "en";
}

/** Whether this caller wants JSON rather than a page.
 *
 * The upload form posts itself with XHR so it can show progress on a
 * 500MB file, and an XHR that receives a redirect to an HTML page has no
 * way to tell success from failure. Same route, same validation, just a
 * machine-readable answer when asked for one. */
function wantsJson(req) {
  return String(req.get?.("accept") || "").includes("application/json");
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
/** The day's Sejbosejbo: the highest-scoring post of the day.
 *
 * Was a deterministic pick from the whole archive, seeded on the date -
 * stable through the day, but it surfaced a random old post rather than
 * anything to do with today. Now it is the post the visitors actually
 * voted up, which is the thing an "award" should mean.
 *
 * The query anchors to the most recent day that HAS posts, so a quiet day
 * keeps showing the last real day's winner instead of going blank. */
async function getDailyUpload() {
  return (await statements.topOfLatestDay.get()) || null;
}

/** Origin used in API media URLs, Open Graph tags and payment redirects.
 * This is configuration, not request data. */
function getOrigin() {
  return PUBLIC_ORIGIN;
}

module.exports = {
  SITE_TZ,
  getLang,
  getCopy,
  wantsJson,
  withLang,
  escapeHtml,
  daysSince,
  formatDate,
  toIsoUtc,
  getTotalVisits,
  getDailyUpload,
  PUBLIC_ORIGIN,
  getOrigin
};
