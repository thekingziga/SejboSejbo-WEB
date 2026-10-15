const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const express = require("express");
const compression = require("compression");

const i18n = require("./lib/i18n");
const { rootDir, uploadDir, statements, clearReports, moderateComment, initDb } = require("./lib/db");
const storage = require("./lib/storage");
const {
  getLang,
  getCopy,
  wantsJson,
  withLang,
  escapeHtml,
  daysSince,
  formatDate,
  getTotalVisits,
  getDailyUpload,
  getOrigin,
  toIsoUtc
} = require("./lib/util");
const { uploadsPaused, upload, imageUpload, isMediaEnabled, acceptAttribute, IMAGE_LIMIT, MEDIA_LIMIT, classifyUploadError } = require("./lib/upload");
const { inputPaused } = require("./lib/pause");
const apiRouter = require("./lib/api");
const wellKnownRouter = require("./lib/wellKnown");
const donations = require("./lib/donations");
const { getNotifyEmail, setNotifyEmail, sendTestEmail } = require("./lib/mail");
const ai = require("./lib/ai");
const preview = require("./lib/preview");
const { securityHeaders } = require("./lib/security");
const forumHome = require("./lib/forumHome");
const posts = require("./lib/posts");
const safety = require("./lib/safety");
const moderation = require("./lib/moderation");
const marketplace = require("./lib/marketplace");
const accounts = require("./lib/accounts");
const marketplaceLimits = require("./lib/marketplaceLimits");

/** Post ids from the URL, or null when the path segment is not a whole
 * number. Number() alone yields NaN for "abc" and 1.5 for "1.5", both of
 * which Postgres rejects outright - so /post/abc answered 500 with a raw
 * database error rather than a 404. */
function postIdFrom(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Today's door to /sweat: the id of the one post carrying the hidden link.
 *
 * Seeded on the date so it is stable through the day - a link that jumped
 * between page loads would be maddening rather than mysterious - and it
 * moves at local midnight. Deliberately not the newest post: the fun is
 * that it can be anywhere in the archive.
 *
 * Resolved to a real id by offset rather than by arithmetic on the id
 * itself, which would land on several posts at once whenever ids wrapped
 * past the archive size. Cached for the day, so this costs two queries
 * every 24 hours rather than two on every post view. */
let sweatDoor = { day: null, id: null };
async function sweatDoorId() {
  const day = new Date().toLocaleDateString("en-CA", { timeZone: process.env.SITE_TIMEZONE || "Europe/Ljubljana" });
  if (sweatDoor.day === day) return sweatDoor.id;

  const total = (await statements.countVisible.get()).count;
  let id = null;
  if (total > 0) {
    const hash = crypto.createHash("sha1").update(`sweat:${day}`).digest();
    const offset = ((hash[0] << 8) | hash[1]) % total;
    id = (await statements.postIdAtOffset.get(offset))?.id ?? null;
  }
  sweatDoor = { day, id };
  return id;
}
const subscribers = require("./lib/subscribers");
const push = require("./lib/push");
const { createRateLimiter } = require("./lib/rateLimit");
const { getClientIp } = require("./lib/ip");

// Read from package.json rather than repeated in a constant here: the
// version is already bumped there on every release, and a second copy is
// a copy that eventually disagrees with the image it is printed on.
const VERSION = require("./package.json").version;

/** Cache-busting token per static asset, from a hash of the file itself.
 *
 * This was the release version, which breaks in the one case it is needed
 * most: editing CSS without bumping the version - every test deploy
 * reused ?v=1.26.0-test and browsers kept serving the previous file. A
 * content hash changes exactly when the file changes, and never when it
 * does not.
 *
 * Read once at startup: these files cannot change under a running
 * container, since they are baked into the image. */
const assetVersions = new Map();
function assetUrl(file) {
  if (!assetVersions.has(file)) {
    let token = VERSION;
    try {
      token = crypto
        .createHash("sha1")
        .update(fs.readFileSync(path.join(rootDir, "public", file)))
        .digest("hex")
        .slice(0, 10);
    } catch (err) {
      // A missing asset is not worth refusing to boot over - fall back to
      // the release version, which is what this used to do anyway.
      console.warn(`[assets] could not hash ${file}: ${err.message}`);
    }
    assetVersions.set(file, token);
  }
  return `/public/${file}?v=${assetVersions.get(file)}`;
}

const { autoWrapAsync } = require("./lib/asyncRoutes");

const app = autoWrapAsync(express());
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "sejbosejbo";
// A missing ADMIN_PASSWORD used to silently fall back to a password
// published in this file, which is the same as no password at all. In
// production that is a refusal to start rather than a quiet compromise;
// development keeps the convenient default.
if (process.env.NODE_ENV === "production" && !process.env.ADMIN_PASSWORD) {
  console.error("[startup] ADMIN_PASSWORD is not set. Refusing to start with the built-in default.");
  process.exit(1);
}
// Same reasoning: without a stable SESSION_SECRET every restart silently
// signs out every admin, and the fallback is regenerated per process.
if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  console.warn("[startup] SESSION_SECRET is not set - admin sessions will not survive a restart.");
}
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

// Node sits behind exactly one reverse-proxy hop: HAProxy on the pfSense
// box (this domain is not Cloudflare-proxied - see lib/ip.js). `1` tells
// Express to trust only that single closest hop, taking the last entry in
// X-Forwarded-For (the one HAProxy itself appended via "option forwardfor")
// as the real client. This also fixes x-forwarded-proto so it reflects the
// real (https) scheme rather than the plain HTTP HAProxy speaks to Node.
//
// Deliberately not `true`: that trusts every hop in a client-supplied
// X-Forwarded-For chain, which would let anyone prepend a fake IP before
// the request even reaches HAProxy and have Express believe it. This only
// holds as long as HAProxy is the *only* way to reach this app - if the
// Pi's port is ever exposed directly, bypassing HAProxy, that assumption
// breaks and X-Forwarded-For becomes spoofable again.
app.set("trust proxy", 1);

// Announcing the framework and version helps nobody but someone looking
// for a matching CVE.
app.disable("x-powered-by");

app.use(securityHeaders());

// ~72% off every HTML response (10KB -> 2.8KB). Static assets are already
// small or pre-compressed formats, so this mostly pays for the pages.
app.use(compression());

// Every page carries live state - visitor counter, random quote, daily
// award, the Sejbometer, AI copy. Express sends an ETag but no
// Cache-Control, which lets browsers heuristically serve a stale copy and
// makes the site look frozen. no-cache still allows revalidation (the
// ETag does its job), it just forbids using a cached page blind.
app.use((req, res, next) => {
  if (!req.path.startsWith("/public") && !req.path.startsWith("/uploads")) {
    res.setHeader("Cache-Control", "no-cache");
  }
  next();
});

function parseCookies(header) {
  const cookies = {};
  for (const item of String(header || "").split(";")) {
    const index = item.indexOf("=");
    if (index === -1) continue;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function signSession(payload) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
}

function encodeSession(sessionData) {
  const payload = Buffer.from(JSON.stringify(sessionData)).toString("base64url");
  return `${payload}.${signSession(payload)}`;
}

function decodeSession(value) {
  if (!value || !value.includes(".")) return {};
  const [payload, signature] = value.split(".");
  const expected = signSession(payload);
  const given = Buffer.from(signature || "");
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return {};

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

/** Set on HTTPS requests only. Hardcoding it would break plain-HTTP
 * local development, where the browser silently drops a Secure cookie and
 * the session simply never persists. */
function cookieIsSecure(req) {
  return Boolean(req.secure || req.headers["x-forwarded-proto"] === "https");
}

function setSessionCookie(res, sessionData, req) {
  const value = encodeURIComponent(encodeSession(sessionData));
  const secure = req && cookieIsSecure(req) ? "; Secure" : "";
  res.setHeader("Set-Cookie", `sejbosejbo_session=${value}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=2592000`);
}

async function getStats(req) {
  const t = getCopy(req);
  // Independent reads - issue them together rather than paying a serial
  // network round trip for each, now that the database is off-box.
  const [latest, daily, visits, uploads, unread] = await Promise.all([
    statements.latestUpload.get(),
    getDailyUpload(),
    getTotalVisits(),
    statements.totalUploads.get(),
    req.user ? statements.unreadConversations.get(req.user.id) : null
  ]);
  return {
    unread: unread?.count || 0,
    visits,
    uploads: uploads.count,
    latest,
    daily,
    quote: (() => { const q = ai.getQuotes(getLang(req)); return q[Math.floor(Math.random() * q.length)]; })()
  };
}

/** Renders whatever a post's file actually is. kind is set at upload time
 * from the MIME type, so old image rows keep working untouched. */
function renderMedia(row, { large = false, processingLabel = "" } = {}, altText = "") {
  if (!row.filename) return null;
  // The object this post points at does not exist yet - the worker is
  // still encoding it. Rendering the <video> anyway would give every
  // visitor a broken player.
  // 'failed' means the encode gave up AND the original could not be
  // promoted either, so there is genuinely nothing to play. Falls through
  // to the text card rather than rendering a player pointed at nothing.
  if (row.media_status === "failed") return null;
  if (row.media_status === "processing") {
    return `<div class="media-processing${large ? " media-processing-large" : ""}">
      <span class="media-processing-spinner" aria-hidden="true"></span>
      <span>${escapeHtml(processingLabel)}</span>
    </div>`;
  }
  // Relative origin: the website serves pages from the same host it serves
  // local uploads from. On the S3 driver this comes back absolute anyway.
  const src = storage.publicUrl(row.filename, "");
  if (row.kind === "video") {
    return `<video class="${large ? "post-media" : "card-video"}" src="${src}" controls preload="metadata" playsinline></video>`;
  }
  if (row.kind === "audio") {
    return `<div class="audio-wrap"><span class="audio-glyph" aria-hidden="true">&#127925;</span><audio src="${src}" controls preload="none"></audio></div>`;
  }
  return `<img class="${large ? "post-image" : ""}" src="${src}" alt="${altText}">`;
}

function renderCard(upload_, req) {
  const t = getCopy(req);
  const title = escapeHtml(upload_.title);
  const description = escapeHtml(upload_.description || "");
  const media = renderMedia(upload_, { large: false, processingLabel: t.mediaProcessing }, title)
    || `<div class="story-card">${description || t.storyFallback}</div>`;

  return `
    <a class="card" href="${withLang(req, `/post/${upload_.id}`)}">
      <div class="card-media">${media}</div>
      ${upload_.featured ? `<span class="badge">${t.featuredBadge}</span>` : ""}
      <strong>${title}</strong>
      <span>${formatDate(upload_.created_at)}</span>
      <div class="vote-row" data-vote-widget data-post-id="${upload_.id}">
        <button type="button" class="vote-btn vote-up" data-vote="1" aria-label="${t.voteUp}">&#9650; <span data-vote-up>${upload_.upvotes || 0}</span></button>
        <button type="button" class="vote-btn vote-down" data-vote="-1" aria-label="${t.voteDown}">&#9660; <span data-vote-down>${upload_.downvotes || 0}</span></button>
        <span class="comment-badge" title="${t.commentsHeading}">&#128172; ${upload_.comment_count || 0}</span>
      </div>
    </a>
  `;
}

function layout({ title, body, stats, req, ogImage, ogDescription, nonce = "", bodyClass = "", hideStatsBar = false, noindex = false }) {
  const lang = getLang(req);
  const t = getCopy(req);
  const safeTitle = escapeHtml(title);
  const latest = stats.latest
    ? `<a href="${withLang(req, `/post/${stats.latest.id}`)}">"${escapeHtml(stats.latest.title)}"</a>`
    : t.noneYet;
  const daily = stats.daily
    ? `<a href="${withLang(req, `/post/${stats.daily.id}`)}">"${escapeHtml(stats.daily.title)}"</a>`
    : t.awaiting;
  const currentPath = req.originalUrl.split("?")[0];
  const sinceLast = daysSince(stats.latest?.created_at);
  const origin = escapeHtml(getOrigin(req));
  const safeDescription = escapeHtml(ogDescription || t.tagline);
  // Posts share their own (blurred) card; everything else shares the logo.
  const shareImage = ogImage ? `${origin}${escapeHtml(ogImage)}` : `${origin}/public/logo.png`;

  return `<!doctype html>
<html lang="${t.htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle} | sejbosejbo.fyi</title>
  <link rel="icon" type="image/png" href="/public/favicon.png">
  <link rel="apple-touch-icon" href="/public/apple-touch-icon.png">
  <meta name="theme-color" content="#ff66cc">
  ${noindex ? `<!-- Kept out of search results without a robots.txt Disallow,
       which would have listed the hidden page in a file anyone can read. -->
  <meta name="robots" content="noindex, nofollow">` : ""}
  <meta name="description" content="${safeDescription}">
  <meta property="og:type" content="${ogImage ? "article" : "website"}">
  <meta property="og:title" content="${safeTitle} | sejbosejbo.fyi">
  <meta property="og:description" content="${safeDescription}">
  <meta property="og:url" content="${origin}${escapeHtml(currentPath)}">
  <meta property="og:image" content="${shareImage}">
  <meta property="og:image:secure_url" content="${shareImage}">
  <meta property="og:image:width" content="${ogImage ? preview.WIDTH : 420}">
  <meta property="og:image:height" content="${ogImage ? preview.HEIGHT : 420}">
  <meta property="og:image:alt" content="${escapeHtml(t.sharePreviewAlt)}">
  <meta name="twitter:card" content="summary_large_image">
  <!-- Runs before the stylesheet and before first paint: a visitor who
       chose dark must never see a flash of white on the way in. This is
       why it is inline rather than in main.js, which loads at the end of
       the body. Carries the CSP nonce like the other inline script. -->
  <script nonce="${nonce}">
    try {
      if (localStorage.getItem("sejbosejbo_theme") === "dark") {
        document.documentElement.setAttribute("data-theme", "dark");
      }
    } catch (e) {}
  </script>
  <link rel="stylesheet" href="${assetUrl("styles.css")}">
</head>
<body class="${bodyClass}">
  <header class="topbar">
    <a href="${withLang(req, "/")}" class="brand"><img class="brand-mark" src="/public/logo.png" alt="">SEJBOSEJBO</a>
    <nav>
      ${process.env.HOMEPAGE_LAYOUT === "forum" ? `<a href="${withLang(req, "/")}">${t.navHome}</a>` : `<a href="${withLang(req, "/gallery")}">${t.navGallery}</a>`}
      <a href="${withLang(req, "/upload")}">${t.navUpload}</a>
      <a href="${withLang(req, "/marketplace")}">${t.navMarket}</a>
      ${req.user ? `<a href="${withLang(req, "/messages")}">${t.navMessages}${stats.unread ? ` <span class="unread-badge">${stats.unread}</span>` : ""}</a>` : ""}
      <a href="${withLang(req, "/support")}">${t.navSupport}</a>
      <a href="${withLang(req, "/about")}">${t.navAbout}</a>
    </nav>
    <div class="topbar-right">
      <button type="button" class="music-toggle" data-music-toggle hidden aria-pressed="false" title="${t.musicToggle}">
        <span data-music-icon>&#128266;</span>
      </button>
      <button type="button" class="theme-toggle" data-theme-toggle aria-pressed="false" title="${t.themeToggle}">
        <span data-theme-icon>&#127769;</span>
      </button>
      <div class="language-switch" aria-label="Language switch">
        <a class="${lang === "en" ? "active" : ""}" href="${currentPath}?lang=en">ENG</a>
        <span>/</span>
        <a class="${lang === "sl" ? "active" : ""}" href="${currentPath}?lang=sl">SLO</a>
      </div>
    </div>
  </header>
  <!-- Shown once per phone by main.js, which is also what blurs the page
       behind it. Rendered on every page but hidden, so it costs nothing on
       desktop and needs no server-side device sniffing - which gets user
       agents wrong constantly. -->
  <div class="mobile-gate" data-mobile-gate hidden>
    <div class="mobile-gate-box">
      <img class="mobile-gate-logo" src="/public/logo.png" alt="">
      <h2>${t.mobileGateTitle}</h2>
      <p>${t.mobileGateBody}</p>
      <a class="mobile-gate-app" href="${withLang(req, "/#app")}" data-mobile-gate-dismiss>${t.mobileGateApp}</a>
      <button type="button" class="mobile-gate-no" data-mobile-gate-dismiss>${t.mobileGateContinue}</button>
    </div>
  </div>
  ${subscribers.isConfigured() ? `
  <!-- First-visit email prompt. Rendered on every page but hidden; main.js
       reveals it once per device and never again after it is dismissed or
       used. Omitted entirely when SMTP is off, so it can never offer
       something that would fail. -->
  <div class="subscribe-pop" data-subscribe-pop hidden>
    <div class="subscribe-pop-inner">
      <button type="button" class="subscribe-pop-close" data-subscribe-dismiss aria-label="${escapeHtml(t.subscribePopupDismiss)}">&times;</button>
      <h2>${t.subscribePopupHeading}</h2>
      <p>${t.subscribePopupBlurb}</p>
      <form class="subscribe-form" data-subscribe-form>
        <label class="sr-only" for="subscribe-pop-email">${t.subscribeEmailLabel}</label>
        <input id="subscribe-pop-email" type="email" name="email" required maxlength="254" autocomplete="email" placeholder="${escapeHtml(t.subscribeEmailLabel)}">
        <button type="submit">${t.subscribeButton}</button>
        <p class="tier-status" data-subscribe-status role="status"></p>
      </form>
      <button type="button" class="subscribe-pop-no" data-subscribe-dismiss>${t.subscribePopupDismiss}</button>
    </div>
  </div>
  ` : ""}
  <!-- No autoplay attribute on purpose: browsers refuse unmuted autoplay
       anyway, and main.js handles the "start on first interaction"
       fallback. preload=none so visitors who never unmute pay nothing -
       this is served off a Raspberry Pi.
       AAC first at roughly half the bytes of the mp3; every current
       browser takes it, and the mp3 stays as the universal fallback. -->
  <audio data-music-audio loop preload="none">
    <source src="/public/theme.m4a" type="audio/mp4">
    <source src="/public/theme.mp3" type="audio/mpeg">
  </audio>
  <main>
    ${body}
    ${hideStatsBar ? "" : `<section class="alive">
      <div><b>${t.visitors}:</b> ${stats.visits.toLocaleString("en-US")}</div>
      <div><b>${t.archived}:</b> ${stats.uploads.toLocaleString("en-US")}</div>
      <div><b>${t.daysSince}:</b> ${sinceLast === null ? "&infin;" : sinceLast.toLocaleString("en-US")}</div>
      <div><b>${t.latest}:</b> ${latest}</div>
      <div><b>${t.daily}:</b> ${daily}</div>
      <div><b>${t.randomQuote}:</b> ${escapeHtml(stats.quote)}</div>
    </section>`}
  </main>
  <footer>
    ${t.official}
    <p class="footer-links"><a href="${withLang(req, "/privacy")}">${t.privacyFooterLink}</a> &middot; <a href="${withLang(req, "/terms")}">${t.termsFooterLink}</a></p>
    <p class="footer-version">v${VERSION}</p>
  </footer>
  <script nonce="${nonce}">
    window.SEJBOSEJBO_COPY = ${JSON.stringify({
      loading: t.loading,
      loadingFailed: t.loadingFailed,
      voteFailed: t.voteFailed,
      reportSubmitted: t.reportSubmitted,
      reportFailed: t.reportFailed,
      appComingSoonMessage: t.appComingSoonMessage,
      testFailedGeneric: t.testFailedGeneric,
      commentPosted: t.commentPosted,
      commentFailed: t.commentFailed,
      commentEmpty: t.commentEmpty,
      commentReport: t.commentReport,
      commentReported: t.commentReported,
      commentReportFailed: t.commentReportFailed,
      supportRedirecting: t.supportRedirecting,
      supportFailed: t.supportFailed
    })};
  </script>
  <!-- ?v= is the release version, so a deploy changes the URL and the
       browser fetches the new file instead of serving the cached one for
       up to an hour. Without this, returning visitors ran the previous
       release's JavaScript and CSS against the new HTML - which is
       exactly how the first-visit email prompt appeared to do nothing. -->
  <script src="${assetUrl("main.js")}"></script>
</body>
</html>`;
}

async function renderPage(req, res, options) {
  res.send(layout({ ...options, req, nonce: res.locals.cspNonce, stats: await getStats(req) }));
}

function requireAdmin(req, res, next) {
  if (req.session.isAdmin) return next();
  return res.redirect(withLang(req, "/admin"));
}

/** JSON-flavoured admin guard. The HTML one redirects, which a fetch()
 * would silently follow and hand back a login page as if it were a
 * result - a 401 says what actually happened. */
function requireAdminJson(req, res, next) {
  if (req.session.isAdmin) return next();
  return res.status(401).json({ ok: false, message: "Not signed in." });
}

function adminNav(req, active) {
  const t = getCopy(req);
  const items = [
    { key: "dashboard", href: "/admin", label: t.adminNavDashboard },
    { key: "comments", href: "/admin/comments", label: t.adminNavComments },
    { key: "marketplace", href: "/admin/marketplace", label: t.adminNavMarket },
    { key: "safety", href: "/admin/safety", label: t.adminNavSafety },
    { key: "metrics", href: "/admin/metrics", label: t.adminNavMetrics },
    { key: "settings", href: "/admin/settings", label: t.adminNavSettings }
  ];
  return `
    <nav class="sort-switch admin-top-nav" aria-label="Admin sections">
      ${items.map((item) => `<a class="${active === item.key ? "active" : ""}" href="${withLang(req, item.href)}">${item.label}</a>`).join("")}
    </nav>
  `;
}

// The Stripe webhook needs the exact raw request bytes to verify its
// signature, so it must bypass express.json() below entirely - only this
// one path is mounted with express.raw() ahead of the global JSON parser.
app.use(
  "/api/v1/webhooks/stripe",
  express.raw({ type: "application/json" }),
  donations.stripeWebhookHandler
);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/** Body-parser failures happen BEFORE any router runs, so a malformed
 * JSON body sent to /api/v1/* fell through to the site's HTML error page -
 * an app expecting JSON got a full web page and a parse error of its own.
 * Anything addressed to the API answers in JSON, whatever went wrong. */
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (!req.path.startsWith("/api/")) return next(err);
  // An upload rejected by multer is a client error with a useful message,
  // not an internal fault - say which limit or type was the problem.
  const upload = classifyUploadError(err, getCopy(req));
  if (upload) {
    if (req.file) storage.discardTemp(req.file);
    return res.status(upload.status).json({ error: upload.message });
  }
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status === 400 ? "Malformed request body." : "Something went wrong." });
});
app.use("/public", express.static(path.join(rootDir, "public"), { maxAge: "1h" }));
// When uploads live in a bucket the browser can't reach directly - a
// self-hosted MinIO on a private address, or simply a private bucket - this
// app fetches them and streams them back. Registered ahead of the static
// handler, which stays as the fallback so files still on local disk (from
// before a migration, or any the bucket is missing) continue to serve.
if (storage.servesFromApp()) {
  app.get("/uploads/:filename", async (req, res, next) => {
    // The filename comes from the URL, so it must not be able to address
    // anything outside the bucket's own key space. Uploads are named
    // <timestamp>-<hex><ext> by lib/upload.js; anything else is not ours.
    const filename = req.params.filename;
    if (!/^[A-Za-z0-9._-]+$/.test(filename) || filename.includes("..")) {
      return res.sendStatus(400);
    }

    let upstream;
    try {
      upstream = await storage.getObject(filename);
    } catch (err) {
      console.error(`[uploads] fetch failed for ${filename}: ${err.message}`);
      return next(); // fall through to local disk
    }

    if (!upstream.ok) return next();

    for (const header of ["content-type", "content-length", "etag", "last-modified"]) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    // Same 7 days the static handler used. Uploads are immutable once
    // written - the filename carries a timestamp and random suffix - so
    // this is safe and keeps repeat views off the bucket entirely.
    res.setHeader("Cache-Control", "public, max-age=604800");

    // pipeline, not pipe: an unhandled 'error' on this stream took the
    // whole process down. A slow or aborted read from the bucket made the
    // Readable emit 'error' with nobody listening, which in Node is a
    // hard exit - one stalled image request killed the site for everyone.
    // pipeline propagates the failure here and destroys both ends.
    try {
      await pipeline(Readable.fromWeb(upstream.body), res);
    } catch (err) {
      // The client going away mid-download is normal, not a fault.
      const clientGone = ["ERR_STREAM_PREMATURE_CLOSE", "ECONNRESET", "EPIPE"].includes(err.code);
      if (!clientGone) console.error(`[uploads] stream failed for ${filename}: ${err.message}`);
      if (!res.headersSent) res.sendStatus(502);
      else res.destroy();
    }
  });
}

app.use("/uploads", express.static(uploadDir, { maxAge: "7d" }));

app.use("/.well-known", wellKnownRouter);

app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  req.session = decodeSession(cookies.sejbosejbo_session);
  // The API never changes the session - it only reads the language - so it
  // never writes the cookie back. That keeps the app's bearer-token
  // requests cookie-free, as its contract promises: a token must never
  // quietly become a browser session.
  if (req.path.startsWith("/api/")) return next();
  const originalEnd = res.end.bind(res);
  res.end = (...args) => {
    setSessionCookie(res, req.session, req);
    return originalEnd(...args);
  };
  next();
});

app.use((req, res, next) => {
  if (req.query.lang === "sl" || req.query.lang === "en") {
    req.session.lang = req.query.lang;
  }
  next();
});

/** The marketplace account, if this browser is logged in. Read fresh on
 * every request rather than trusted from the cookie: the cookie only
 * carries an id, so a deleted account is logged out everywhere at once,
 * and a renamed one shows its new name on the next page. */
app.use(async (req, res, next) => {
  req.user = null;
  if (!req.session.userId || req.path.startsWith("/api/v1")) return next();
  req.user = (await statements.userById.get(req.session.userId)) || null;
  if (!req.user) delete req.session.userId;
  next();
});

app.use((req, res, next) => {
  // The visit counter is for humans browsing the website; the JSON API has
  // its own callers (the app) and must not inflate it.
  if (req.path.startsWith("/api/v1")) return next();
  if (!req.session.countedVisit) {
    // Deliberately not awaited: this is a novelty counter, and making every
    // first page view wait on a write to a database on another machine is a
    // worse trade than occasionally missing a count. The .catch() is
    // required - an unhandled rejection here would take the process down.
    statements.incrementVisits.run()
      .catch((err) => console.error(`[visits] increment failed: ${err.message}`));
    req.session.countedVisit = true;
  }
  next();
});

app.use("/api/v1", apiRouter);

/** Booru/forum-style front page, selected with HOMEPAGE_LAYOUT=forum.
 *
 * Kept behind a flag rather than replacing the original outright: the two
 * layouts are very different, and this way the switch is an env var on one
 * server instead of a branch that has to be kept in sync. */
async function renderForumHome(req, res) {
  const t = getCopy(req);
  const perPage = forumHome.clampPageSize();
  const requestedPage = Math.max(1, Number(req.query.page) || 1);

  // Same four tabs the gallery has, so the front page can do the gallery's
  // job and the nav does not need to offer both.
  const sort = Object.hasOwn(GALLERY_SORTS, req.query.sort) ? req.query.sort : "latest";
  const { statement, count } = GALLERY_SORTS[sort];

  const [total, daily, featured, random, comments, votes, commentCount, todayCount, visitorTotal] =
    await Promise.all([
      statements[count].get().then((r) => r.count),
      getDailyUpload(),
      statements.featuredUpload.get(),
      statements.randomUpload.get(),
      statements.recentCommentsPublic.all(6),
      statements.totalVotesCast.get().then((r) => r.total),
      statements.totalComments.get().then((r) => r.count),
      statements.countUploadsToday.get().then((r) => r.count),
      getTotalVisits()
    ]);

  // Clamped after the count is known, so /?page=9999 lands on the last
  // real page instead of an empty grid.
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(requestedPage, totalPages);
  const posts = await statements[statement].all(perPage, (page - 1) * perPage);

  const examples = ai.getExamples(getLang(req));
  const meterPercent = Math.min(Math.round((todayCount / METER_TARGET) * 100), 100);
  const meterMaxed = todayCount >= METER_TARGET;

  // Every link keeps whichever sort/page-size the visitor is on, so
  // changing page does not silently drop them back to the defaults.
  const hrefFor = (targetPage, _size, nextSort = sort) => {
    const params = new URLSearchParams();
    if (targetPage > 1) params.set("page", String(targetPage));
    if (nextSort !== "latest") params.set("sort", nextSort);
    const query = params.toString();
    return escapeHtml(withLang(req, `/${query ? `?${query}` : ""}`));
  };

  const sortNavHtml = `
    <nav class="sort-switch fx-sorts" aria-label="Sort">
      ${[
        ["latest", t.sortLatest],
        ["top", t.sortTop],
        ["featured", t.sortFeatured],
        ["pinned", t.sortPinned]
      ]
        .map(
          ([value, label]) =>
            `<a class="${value === sort ? "active" : ""}" href="${hrefFor(1, perPage, value)}">${escapeHtml(label)}</a>`
        )
        .join("")}
    </nav>`;

  const heroHtml = `
    <section class="fx-hero">
      <button class="logo-button" type="button" aria-label="Bounce the Sejbosejbo logo"><img class="hero-logo" src="/public/logo.png" alt="">SEJBOSEJBO</button>
      <p class="tagline">${t.tagline}</p>
      <div class="fx-hero-cols">
        <div class="examples">
          ${examples.slice(0, -1).map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
          <p><b>${escapeHtml(examples[examples.length - 1])}</b></p>
        </div>
        <div class="fx-hero-right">
          <div class="counter-box">${t.visitorLine} #${visitorTotal.toLocaleString("en-US")}</div>
          <div class="button-zone">
            <button class="chaos-button" data-random-button type="button">SEJBOSEJBO</button>
            <output class="random-result" data-random-result>${t.pressIt}</output>
          </div>
        </div>
      </div>
    </section>`;

  const meterHtml = `
    <div class="meter fx-meter">
      <div class="meter-track" role="progressbar" aria-valuenow="${meterPercent}" aria-valuemin="0" aria-valuemax="100">
        <div class="meter-fill${meterMaxed ? " maxed" : ""}" style="width:${meterPercent}%"></div>
      </div>
      <p>${
        meterMaxed
          ? t.meterResultMax
          : todayCount === 0
            ? t.meterResultEmpty
            : t.meterResultBuilding.replace("{count}", todayCount).replace("{needed}", METER_TARGET)
      }</p>
    </div>`;

  const appHtml = `
    <p class="fx-app-sub">${t.appSub}</p>
    <div class="badge-row fx-badge-row">
      ${[
        ["Windows", "&#128421;"],
        ["Android", "&#129302;"],
        ["iPhone", "&#128241;"],
        ["macOS", "&#128187;"]
      ]
        .map(
          ([name, icon]) => `
        <button type="button" class="app-badge" data-app-badge="${name}">
          <span class="app-badge-icon" aria-hidden="true">${icon}</span>
          <span class="app-badge-text"><small>${t.appComingSoon}</small>${name}</span>
        </button>`
        )
        .join("")}
    </div>`;

  await renderPage(req, res, {
    title: t.homeTitle,
    body: forumHome.render({
      t,
      req,
      escapeHtml,
      withLang,
      posts,
      total,
      page,
      perPage,
      daily,
      featured,
      random,
      comments,
      stats: {
        visits: visitorTotal,
        uploads: total,
        votes,
        comments: commentCount,
        // Same pick as the stats strip this layout replaced - it just
        // lives in a panel now instead of a footer row.
        quote: (() => {
          const q = ai.getQuotes(getLang(req));
          return q[Math.floor(Math.random() * q.length)];
        })()
      },
      // Reuses the blurred share card as the thumbnail source? No - that
      // would hide the picture from the people already on the site. This
      // is the real image, served through the same path the cards use.
      //
      // Only ever returns something an <img> can actually decode. Handing
      // it a video's own URL is what produced a broken-image icon on every
      // video tile; a video shows its captured poster or nothing.
      thumbFor: (post) => {
        if (!post) return null;
        if (post.kind === "image" && post.filename) return storage.publicUrl(post.filename, "");
        if (post.kind === "video" && post.poster) return storage.publicUrl(post.poster, "");
        return null;
      },
      hrefFor,
      formatDate,
      heroHtml,
      sortNavHtml,
      meterHtml,
      appHtml
    }),
    // Widens the page: this layout wants the whole window, not the 1100px
    // column the article pages read better in.
    bodyClass: "layout-forum",
    // The footer stats strip repeats what the sidebar already shows -
    // visitor count, archive size, latest post, daily award, random quote
    // are all panels up there. Suppressed here only; every other page
    // still gets it.
    hideStatsBar: true
  });
}

app.get("/", async (req, res) => {
  if (process.env.HOMEPAGE_LAYOUT === "forum") return await renderForumHome(req, res);
  const t = getCopy(req);
  const newest = await statements.newestUploads.all(8);
  const cards = newest.length ? newest.map((item) => renderCard(item, req)).join("") : `<p class="empty">${t.emptyHome}</p>`;
  const examples = ai.getExamples(getLang(req));

  // The Sejbometer measures TODAY, not the whole archive - an all-time
  // count would sit pegged at MAX forever once the archive got past six
  // and stop meaning anything. This way it empties overnight and fills as
  // the day's uploads come in.
  const [uploadCount, visitorTotal] = await Promise.all([
    statements.countUploadsToday.get().then((r) => r.count),
    getTotalVisits()
  ]);
  const meterPercent = Math.min(Math.round((uploadCount / METER_TARGET) * 100), 100);
  const meterMaxed = uploadCount >= METER_TARGET;

  await renderPage(req, res, {
    title: t.homeTitle,
    body: `
      <section class="hero">
        <button class="logo-button" type="button" aria-label="Bounce the Sejbosejbo logo"><img class="hero-logo" src="/public/logo.png" alt="">SEJBOSEJBO</button>
        <p class="tagline">${t.tagline}</p>
      </section>

      <section class="examples">
        ${examples.slice(0, -1).map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
        <p><b>${escapeHtml(examples[examples.length - 1])}</b></p>
      </section>

      <section class="counter-box">${t.visitorLine} #${visitorTotal.toLocaleString("en-US")}</section>

      <section class="button-zone">
        <button class="chaos-button" data-random-button type="button">SEJBOSEJBO</button>
        <output class="random-result" data-random-result>${t.pressIt}</output>
      </section>

      <section class="meter">
        <h2>${t.meterTitle}</h2>
        <div class="meter-track" role="progressbar" aria-valuenow="${meterPercent}" aria-valuemin="0" aria-valuemax="100">
          <div class="meter-fill${meterMaxed ? " maxed" : ""}" style="width:${meterPercent}%"></div>
        </div>
        <p>${
          meterMaxed
            ? t.meterResultMax
            : uploadCount === 0
              ? t.meterResultEmpty
              : t.meterResultBuilding.replace("{count}", uploadCount).replace("{needed}", METER_TARGET)
        }</p>
      </section>

      <section>
        <div class="section-head">
          <h2>${t.newest}</h2>
          <a href="${withLang(req, "/gallery")}">${t.seeAll}</a>
        </div>
        <div class="grid">${cards}</div>
      </section>

      <section class="app-badges">
        <h2>${t.appHeading}</h2>
        <p>${t.appSub}</p>
        <div class="badge-row">
          <button type="button" class="app-badge" data-app-badge="Windows">
            <span class="app-badge-icon" aria-hidden="true">&#128421;</span>
            <span class="app-badge-text"><small>${t.appComingSoon}</small>Windows</span>
          </button>
          <button type="button" class="app-badge" data-app-badge="Android">
            <span class="app-badge-icon" aria-hidden="true">&#129302;</span>
            <span class="app-badge-text"><small>${t.appComingSoon}</small>Android</span>
          </button>
          <button type="button" class="app-badge" data-app-badge="iPhone">
            <span class="app-badge-icon" aria-hidden="true">&#128241;</span>
            <span class="app-badge-text"><small>${t.appComingSoon}</small>iPhone</span>
          </button>
          <button type="button" class="app-badge" data-app-badge="macOS">
            <span class="app-badge-icon" aria-hidden="true">&#128187;</span>
            <span class="app-badge-text"><small>${t.appComingSoon}</small>macOS</span>
          </button>
        </div>
        <output class="app-badge-status" data-app-badge-status></output>
      </section>
    `
  });
});

// Uploads needed to peg the Sejbometer at MAX.
const METER_TARGET = 6;

const GALLERY_SORTS = {
  // "latest" means latest - no pinned bump. Pinned posts get their own tab
  // rather than jumping the queue, matching how the API behaves.
  latest: { statement: "pagedUploadsNewestApi", count: "countVisible" },
  top: { statement: "pagedUploadsTop", count: "countVisible" },
  featured: { statement: "pagedUploadsFeatured", count: "countFeatured" },
  pinned: { statement: "pagedUploadsPinned", count: "countPinned" }
};

/** Page numbers with ellipsis, e.g.  < 1 ... 4 [5] 6 ... 12 >
 * Always shows first/last so you can jump to either end from anywhere. */
function renderPager(current, totalPages, hrefFor, t) {
  if (totalPages <= 1) return "";

  const numbers = new Set([1, totalPages, current]);
  for (let offset = 1; offset <= 2; offset += 1) {
    if (current - offset >= 1) numbers.add(current - offset);
    if (current + offset <= totalPages) numbers.add(current + offset);
  }
  const sorted = [...numbers].sort((a, b) => a - b);

  const parts = [];
  parts.push(current > 1
    ? `<a class="pager-step" href="${hrefFor(current - 1)}" rel="prev" aria-label="${t.pagerPrev}">&lsaquo;</a>`
    : `<span class="pager-step disabled" aria-hidden="true">&lsaquo;</span>`);

  let previous = 0;
  for (const number of sorted) {
    if (number - previous > 1) parts.push(`<span class="pager-gap">&hellip;</span>`);
    parts.push(number === current
      ? `<span class="pager-page active" aria-current="page">${number}</span>`
      : `<a class="pager-page" href="${hrefFor(number)}">${number}</a>`);
    previous = number;
  }

  parts.push(current < totalPages
    ? `<a class="pager-step" href="${hrefFor(current + 1)}" rel="next" aria-label="${t.pagerNext}">&rsaquo;</a>`
    : `<span class="pager-step disabled" aria-hidden="true">&rsaquo;</span>`);

  return `<nav class="pager" aria-label="Pagination">${parts.join("")}</nav>`;
}

app.get("/gallery", async (req, res) => {
  const t = getCopy(req);
  const perPage = 24;
  const sort = Object.hasOwn(GALLERY_SORTS, req.query.sort) ? req.query.sort : "latest";
  const { statement, count } = GALLERY_SORTS[sort];

  const total = (await statements[count].get()).count;
  const totalPages = Math.max(Math.ceil(total / perPage), 1);
  // Clamp instead of 404ing: a stale bookmark from before posts were
  // deleted should land on the last real page, not an error.
  const page = Math.min(Math.max(Number(req.query.page || 1) || 1, 1), totalPages);

  const visible = await statements[statement].all(perPage, (page - 1) * perPage);

  const query = (params) => {
    const parts = Object.entries(params).filter(([, v]) => v !== null && v !== undefined);
    return parts.length ? `?${parts.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
  };
  const sortLink = (value, label) =>
    `<a class="${sort === value ? "active" : ""}" href="${withLang(req, `/gallery${query({ sort: value === "latest" ? null : value })}`)}">${label}</a>`;
  const pageHref = (number) =>
    withLang(req, `/gallery${query({ sort: sort === "latest" ? null : sort, page: number === 1 ? null : number })}`);

  await renderPage(req, res, {
    title: t.galleryTitle,
    body: `
      <section class="plain-head">
        <h1>${t.allUploads}</h1>
        <p>${t.gallerySub}</p>
      </section>
      <nav class="sort-switch" aria-label="Sort">
        ${sortLink("latest", t.sortLatest)}
        ${sortLink("top", t.sortTop)}
        ${sortLink("featured", t.sortFeatured)}
        ${sortLink("pinned", t.sortPinned)}
      </nav>
      <div class="grid">${visible.length ? visible.map((item) => renderCard(item, req)).join("") : `<p class="empty">${t.emptyGallery}</p>`}</div>
      ${renderPager(page, totalPages, pageHref, t)}
      ${total > 0 ? `<p class="pager-summary">${t.pagerSummary.replace("{page}", page).replace("{total}", totalPages).replace("{count}", total.toLocaleString("en-US"))}</p>` : ""}
    `
  });
});

/** The page (or JSON) a paused form answers with. */
async function renderPaused(req, res, { code, titleKey, textKey }) {
  const t = getCopy(req);
  if (req.method !== "GET") res.status(503);
  if (wantsJson(req)) return res.json({ error: t[textKey], code });
  await renderPage(req, res, {
    title: t[titleKey],
    body: `<section class="plain-head"><h1>${t[titleKey]}</h1><p>${t[textKey]}</p></section>`
  });
}

/** Stands in for the upload and new-listing forms, and refuses their
 * POSTs before multer runs, while UPLOADS_PAUSED (or INPUT_PAUSED) is on. */
async function refuseWhilePaused(req, res, next) {
  if (!uploadsPaused()) return next();
  const input = inputPaused();
  await renderPaused(req, res, {
    code: "uploads_paused",
    titleKey: input ? "inputPausedTitle" : "uploadsPausedTitle",
    textKey: input ? "inputPaused" : "uploadsPaused"
  });
}

/** INPUT_PAUSED: marketplace messages, offers and name changes. Comments
 * and votes go through /api/v1 and are refused there. See lib/pause.js. */
async function refuseInputWhilePaused(req, res, next) {
  if (!inputPaused()) return next();
  await renderPaused(req, res, { code: "input_paused", titleKey: "inputPausedTitle", textKey: "inputPaused" });
}

app.get("/upload", refuseWhilePaused, async (req, res) => {
  const t = getCopy(req);
  // Counts this browser's posts for the hourly limit, and proves a POST
  // came from someone who opened this page: a script firing straight at
  // /upload without the cookie is turned away.
  if (!req.session.uploaderId) req.session.uploaderId = crypto.randomBytes(12).toString("base64url");
  await renderPage(req, res, {
    title: t.uploadTitle,
    body: `
      <section class="plain-head">
        <h1>${t.submitTitle}</h1>
        <p>${t.submitSub}</p>
      </section>
      <form class="form" method="post" action="${withLang(req, "/upload")}" enctype="multipart/form-data" data-upload-form data-progress-threshold="${UPLOAD_PROGRESS_THRESHOLD_MB}">
        <label>${t.titleLabel} <input name="title" maxlength="120" required placeholder="${t.titlePlaceholder}"></label>
        <label>${t.descLabel} <textarea name="description" maxlength="1200" rows="6" placeholder="${t.descPlaceholder}"></textarea></label>
        <label>${isMediaEnabled() ? t.fileLabelMedia : t.fileLabel} <small class="upload-limits">${escapeHtml(uploadLimitHint(t))}</small> <input name="image" type="file" accept="${acceptAttribute()}" data-image-input></label>
        <p class="paste-hint">${t.pasteHint}</p>
        <div class="paste-preview" data-paste-preview hidden><img alt=""></div>
        <input type="hidden" name="poster" data-poster-field>
        <label class="trap" aria-hidden="true">Website <input name="website" tabindex="-1" autocomplete="off"></label>
        <div class="upload-progress" data-upload-progress hidden
             data-copy-progress="${escapeHtml(t.uploadProgress)}"
             data-copy-saving="${escapeHtml(t.uploadSaving)}"
             data-copy-failed="${escapeHtml(t.uploadFailedGeneric)}"
             data-copy-busy="${escapeHtml(t.uploadInProgress)}">
          <progress max="100" value="0" data-progress-bar></progress>
          <p class="upload-progress-text" data-progress-text aria-live="polite"></p>
        </div>
        <p class="upload-error" data-upload-error role="alert" hidden></p>
        <button type="submit" data-upload-submit>${t.submitButton}</button>
      </form>
    `
  });
});

/** Below this a browser upload finishes fast enough that a progress bar
 * would only ever flash. Above it, the page would otherwise sit there
 * looking frozen for minutes. */
const UPLOAD_PROGRESS_THRESHOLD_MB = Number(process.env.UPLOAD_PROGRESS_THRESHOLD_MB || 50);

/** Says the ceiling up front. At 500MB an upload can take minutes, so
 * finding out it was too big only after waiting is a bad trade. */
function uploadLimitHint(t) {
  const mb = (bytes) => `${Math.round(bytes / (1024 * 1024))}MB`;
  return isMediaEnabled()
    ? t.limitHintMedia.replace("{image}", mb(IMAGE_LIMIT)).replace("{media}", mb(MEDIA_LIMIT))
    : t.limitHintImage.replace("{image}", mb(IMAGE_LIMIT));
}

/** One page for every refusal on the upload form - or JSON, for the
 * progress-bar script, which shows the message in place. */
async function uploadRefusal(req, res, status, message) {
  const t = getCopy(req);
  if (wantsJson(req)) return res.status(status).json({ error: message });
  res.status(status);
  return await renderPage(req, res, {
    title: t.uploadErrorTitle,
    body: `<section class="plain-head"><h1>${t.uploadErrorTitle}</h1><p>${escapeHtml(message)}</p><p><a href="${withLang(req, "/upload")}">${t.tryAgain}</a></p></section>`
  });
}

/** Before multer: no file is received from a browser that never opened the
 * form, or that has used its posts for the hour. See lib/posts.js. */
async function reserveUploadSlot(req, res, next) {
  const t = getCopy(req);
  if (!req.session.uploaderId) return await uploadRefusal(req, res, 400, t.uploadNeedsForm);
  req.sender = safety.who(req, { deviceId: req.session.uploaderId, userId: req.user?.id });
  if (await safety.bannedKey(req.sender)) return await uploadRefusal(req, res, 403, t.banned);
  req.uploadKeys = posts.quotaKeys(req, req.session.uploaderId);
  const wait = posts.reserveUpload(req.uploadKeys);
  if (!wait) return next();
  res.setHeader("Retry-After", String(wait));
  return await uploadRefusal(req, res, 429, posts.quotaMessage(getLang(req), wait));
}

app.post("/upload", refuseWhilePaused, reserveUploadSlot, upload.single("image"), async (req, res) => {
  const t = getCopy(req);
  // The hidden "website" field: people never see it, form-filling bots
  // fill everything. Answered like a success so the bot learns nothing.
  if (req.body.website) {
    storage.discardTemp(req.file);
    posts.releaseUpload(req.uploadKeys);
    console.warn(`[upload] honeypot filled from ${getClientIp(req)}`);
    return wantsJson(req) ? res.status(201).json({ url: withLang(req, "/") }) : res.redirect(withLang(req, "/"));
  }

  const result = await posts.createPost({
    file: req.file,
    title: req.body.title,
    description: req.body.description,
    poster: req.body.poster,
    lang: getLang(req),
    sender: req.sender
  });
  if (!result.counts) posts.releaseUpload(req.uploadKeys);
  if (!result.ok) return await uploadRefusal(req, res, result.status, result.message);

  const target = withLang(req, result.held ? "/upload/held" : `/post/${result.post.id}`);
  if (wantsJson(req)) return res.status(201).json({ url: target });
  res.redirect(target);
});

app.get("/upload/held", async (req, res) => {
  const t = getCopy(req);
  await renderPage(req, res, {
    title: t.uploadHeldTitle,
    body: `<section class="plain-head"><h1>${t.uploadHeldTitle}</h1><p>${t.uploadHeld}</p><p><a href="${withLang(req, "/")}">${t.homeTitle}</a></p></section>`
  });
});

/** The blurred share card for a post. Scrapers (WhatsApp, Facebook,
 * Signal, Discord) fetch this when someone pastes a link; nobody browsing
 * the site ever loads it. Rendering is cached in-process, so the usual
 * case is a cache hit and this costs nothing.
 *
 * On any failure it redirects to the logo rather than erroring - a broken
 * share card should degrade to the old behaviour, not to no preview. */
app.get("/post/:id/preview.jpg", async (req, res) => {
  const id = postIdFrom(req.params.id);
  if (id === null) return res.redirect(302, "/public/logo.png");
  const post = await statements.uploadByIdPublic.get(id);
  // Images only. previewFor() downloads the object and hands it to sharp,
  // so on a video post this fetched the entire file - up to 500MB - purely
  // for sharp to reject it as "unsupported image format", and the failure
  // is not cached, so every share-card request did it again.
  const image = post?.filename && post.kind === "image" ? await preview.previewFor(post.filename) : null;
  if (!image) return res.redirect(302, "/public/logo.png");

  res.set({
    "Content-Type": "image/jpeg",
    "Content-Length": String(image.length),
    "Cache-Control": "public, max-age=604800"
  });
  res.end(image);
});

app.get("/post/:id", async (req, res) => {
  const t = getCopy(req);
  const id = postIdFrom(req.params.id);
  const post = id === null ? null : await statements.uploadByIdPublic.get(id);
  if (!post) return res.status(404).redirect(withLang(req, "/404"));
  const title = escapeHtml(post.title);
  const description = escapeHtml(post.description || "");
  const media = renderMedia(post, { large: true, processingLabel: t.mediaProcessing }, title)
    || `<div class="post-story">${description}</div>`;
  // First page only - the rest load client-side if the thread is long.
  const comments = await statements.commentsForPost.all(post.id, 50, 0);

  await renderPage(req, res, {
    title: post.title,
    // Only image posts get a card - a text-only "story" has nothing to
    // blur, so it keeps sharing the logo.
    ogImage: post.filename ? `/post/${post.id}/preview.jpg` : null,
    ogDescription: post.description || null,
    body: `
      <article class="post">
        <h1>${title}</h1>
        ${media}
        ${post.filename && description ? `<p>${description}</p>` : ""}
        <time>${formatDate(post.created_at)}</time>
        ${
          // The door. A full stop, barely visible, no hover cue, no title
          // attribute - findable if you are the sort of person who
          // selects all the text on a page, invisible otherwise.
          (await sweatDoorId()) === post.id
            ? `<a class="sw-door" rel="nofollow" href="${withLang(req, "/sweat")}" aria-label="${escapeHtml(t.sweatSecret)}">.</a>`
            : ""
        }
        <div class="vote-row vote-row-large" data-vote-widget data-post-id="${post.id}">
          <button type="button" class="vote-btn vote-up" data-vote="1" aria-label="${t.voteUp}">&#9650; ${t.voteUp} <span data-vote-up>${post.upvotes || 0}</span></button>
          <button type="button" class="vote-btn vote-down" data-vote="-1" aria-label="${t.voteDown}">&#9660; ${t.voteDown} <span data-vote-down>${post.downvotes || 0}</span></button>
        </div>

        <div class="report-widget" data-report-widget data-post-id="${post.id}">
          <button type="button" class="report-toggle" data-report-toggle>${t.reportButton}</button>
          <form class="report-form" data-report-form hidden>
            <label>${t.reportReasonLabel}
              <select name="reason" required>
                <option value="spam">${t.reportReasonSpam}</option>
                <option value="inappropriate">${t.reportReasonInappropriate}</option>
                <option value="harassment">${t.reportReasonHarassment}</option>
                <option value="copyright">${t.reportReasonCopyright}</option>
                <option value="other">${t.reportReasonOther}</option>
              </select>
            </label>
            <label>${t.reportDetailsLabel}
              <textarea name="details" maxlength="500" rows="3" placeholder="${t.reportDetailsPlaceholder}"></textarea>
            </label>
            <div class="report-actions">
              <button type="submit">${t.reportSubmit}</button>
              <button type="button" data-report-cancel>${t.reportCancel}</button>
            </div>
            <p class="report-status" data-report-status role="status"></p>
          </form>
        </div>

        <h2>${t.official}</h2>
      </article>

      <section class="comments" data-comments data-post-id="${post.id}">
        <h2>${t.commentsHeading} <span data-comment-count>${post.comment_count || 0}</span></h2>
        ${inputPaused() ? `<p class="comment-status">${t.inputPaused}</p>` : `<form class="comment-form" data-comment-form>
          <label class="visually-hidden" for="comment-body">${t.commentPlaceholder}</label>
          <textarea id="comment-body" name="body" maxlength="1000" rows="3" required placeholder="${t.commentPlaceholder}"></textarea>
          <div class="comment-actions">
            <button type="submit">${t.commentSubmit}</button>
            <span class="comment-note">${t.commentAnonNote}</span>
          </div>
          <p class="comment-status" data-comment-status role="status"></p>
        </form>`}
        <ol class="comment-list" data-comment-list>
          ${
            comments.length
              ? comments.map((c) => `
                  <li class="comment" data-comment-id="${c.id}">
                    <p>${escapeHtml(c.body)}</p>
                    <div class="comment-meta">
                      <div class="vote-row comment-votes" data-comment-vote-widget data-comment-id="${c.id}">
                        <button type="button" class="vote-btn vote-up" data-cvote="1" aria-label="${t.voteUp}">&#9650; <span data-cvote-up>${c.upvotes || 0}</span></button>
                        <button type="button" class="vote-btn vote-down" data-cvote="-1" aria-label="${t.voteDown}">&#9660; <span data-cvote-down>${c.downvotes || 0}</span></button>
                      </div>
                      <time>${formatDate(c.created_at)}</time>
                      <button type="button" class="comment-report" data-comment-report="${c.id}">${t.commentReport}</button>
                    </div>
                    <form class="report-form comment-report-form" data-comment-report-form="${c.id}" hidden>
                      <label>${t.reportReasonLabel}
                        <select name="reason" required>
                          <option value="spam">${t.reportReasonSpam}</option>
                          <option value="inappropriate" selected>${t.reportReasonInappropriate}</option>
                          <option value="harassment">${t.reportReasonHarassment}</option>
                          <option value="copyright">${t.reportReasonCopyright}</option>
                          <option value="other">${t.reportReasonOther}</option>
                        </select>
                      </label>
                      <label>${t.reportDetailsLabel}
                        <textarea name="details" maxlength="500" rows="2" placeholder="${t.reportDetailsPlaceholder}"></textarea>
                      </label>
                      <div class="report-actions">
                        <button type="submit">${t.reportSubmit}</button>
                        <button type="button" data-comment-report-cancel>${t.reportCancel}</button>
                      </div>
                      <p class="report-status" data-comment-report-status role="status"></p>
                    </form>
                  </li>
                `).join("")
              : `<li class="comment empty" data-comment-empty>${t.commentsEmpty}</li>`
          }
        </ol>
      </section>
    `
  });
});

app.get("/privacy", async (req, res) => {
  const t = getCopy(req);
  await renderPage(req, res, {
    title: t.privacyTitle,
    body: `
      <section class="plain-head">
        <h1>${t.privacyTitle}</h1>
        <p>${t.privacyUpdated}</p>
      </section>
      <article class="policy">
        <p>${t.privacyIntro}</p>

        <h2>${t.privacyCollectHeading}</h2>
        <ul>
          <li>${t.privacyCollectUploads}</li>
          <li>${t.privacyCollectScan}</li>
          <li>${t.privacyCollectDevice}</li>
          <li>${t.privacyCollectIp}</li>
          <li>${t.privacyCollectVisits}</li>
        </ul>

        <h2>${t.privacyNotCollectHeading}</h2>
        <ul>
          ${t.privacyNotCollectList.map((item) => `<li>${item}</li>`).join("")}
        </ul>

        <h2>${t.privacyEmailHeading}</h2>
        <p>${t.privacyEmailSubscribe}</p>
        <p>${t.privacyEmailMarket}</p>
        <p>${t.privacyEmailApp}</p>

        <h2>${t.privacyPushHeading}</h2>
        <p>${t.privacyPushBody}</p>

        <h2>${t.privacyThirdPartiesHeading}</h2>
        <p>${t.privacyThirdPartiesCloudflare}</p>
        <p>${t.privacyThirdPartiesTips}</p>

        <h2>${t.privacyChildrenHeading}</h2>
        <p>${t.privacyChildrenBody}</p>

        <h2>${t.privacyRemovalHeading}</h2>
        <p>${t.privacyRemovalBody}</p>

        <h2>${t.privacyChangesHeading}</h2>
        <p>${t.privacyChangesBody}</p>
      </article>
    `
  });
});

// Play Console stores a fixed URL and rechecks it periodically, so this
// alias just has to keep resolving - a redirect is fine, a 404 later isn't.
app.get("/privacy.html", async (req, res) => {
  res.redirect(301, withLang(req, "/privacy"));
});

/** Tipping, browser edition.
 *
 * The website is the one surface where Stripe is allowed: Apple's and
 * Google's rules about using their billing apply to the phone apps, not to
 * a web page. The apps therefore hit /donations/apple|google/verify
 * instead, and never see this page.
 *
 * The tier buttons post to the same /api/v1/donations/stripe/session
 * endpoint the desktop apps use - amounts live on the server, so nothing
 * here can ask Stripe for a different price. */
app.get("/support", async (req, res) => {
  const t = getCopy(req);
  const enabled = donations.isStripeConfigured();

  const tier = (id, label, note) => `
    <button type="button" class="tier" data-tier="${id}" ${enabled ? "" : "disabled"}>
      <strong>${label}</strong>
      <span class="tier-amount">${donations.TIERS[id].amount_minor / 100} &euro;</span>
      <small>${note}</small>
    </button>`;

  await renderPage(req, res, {
    title: t.supportTitle,
    body: `
      <section class="plain-head">
        <h1>${t.supportTitle}</h1>
        <p>${t.supportIntro}</p>
      </section>
      <article class="policy support-page">
        <p><em>${t.supportNoPerks}</em></p>

        <h2>${t.supportPickAmount}</h2>
        ${enabled ? `
          <div class="tier-row" data-tier-row>
            ${tier("small", t.supportSmall, t.supportSmallNote)}
            ${tier("medium", t.supportMedium, t.supportMediumNote)}
            ${tier("large", t.supportLarge, t.supportLargeNote)}
          </div>
          <p class="tier-status" data-tier-status role="status"></p>
        ` : `<p class="tier-unavailable">${t.supportUnavailable}</p>`}

        <p class="fine-print">${t.supportPaymentNote}</p>
        <p class="fine-print">${t.supportAppsNote}</p>

        <h2>${t.subscribeHeading}</h2>
        <p>${t.subscribeBlurb}</p>
        ${subscribers.isConfigured() ? `
          <form class="form skinny subscribe-form" data-subscribe-form>
            <label>${t.subscribeEmailLabel}
              <input type="email" name="email" required maxlength="254" autocomplete="email">
            </label>
            <button type="submit">${t.subscribeButton}</button>
            <p class="tier-status" data-subscribe-status role="status"></p>
          </form>
        ` : `<p class="tier-unavailable">${t.subscribeUnavailable}</p>`}
      </article>
    `
  });
});

/** Double opt-in landing pages. Both are plain GETs so they work from a
 * mail client with no JavaScript. */
app.get("/subscribe/confirm", async (req, res) => {
  const t = getCopy(req);
  const result = await subscribers.confirmSubscription(String(req.query.token || ""));
  if (!result.ok) res.status(400);
  await renderPage(req, res, {
    title: result.ok ? t.subscribeConfirmedTitle : t.subscribeBadTokenTitle,
    body: `<section class="plain-head">
      <h1>${result.ok ? t.subscribeConfirmedTitle : t.subscribeBadTokenTitle}</h1>
      <p>${result.ok ? t.subscribeConfirmedBody : t.subscribeBadTokenBody}</p>
    </section>`
  });
});

/** Accepts GET so the link in an email just works, and POST so mail
 * clients supporting List-Unsubscribe-Post one-click can use it. */
async function renderUnsubscribe(req, res) {
  const t = getCopy(req);
  const token = String(req.query.token || req.body?.token || "");
  const result = await subscribers.unsubscribe(token);
  if (!result.ok) res.status(400);
  await renderPage(req, res, {
    title: result.ok ? t.unsubscribedTitle : t.subscribeBadTokenTitle,
    body: `<section class="plain-head">
      <h1>${result.ok ? t.unsubscribedTitle : t.subscribeBadTokenTitle}</h1>
      <p>${result.ok ? t.unsubscribedBody : t.subscribeBadTokenBody}</p>
    </section>`
  });
}

app.get("/unsubscribe", renderUnsubscribe);
app.post("/unsubscribe", renderUnsubscribe);

// Where Stripe sends the customer back to. These are plain pages, not
// confirmation: the actual record is written by the webhook, which is the
// only thing Stripe signs. A visitor can reach /donate/thanks by typing it,
// so it must never be treated as proof anything was paid.
app.get("/donate/thanks", async (req, res) => {
  const t = getCopy(req);
  await renderPage(req, res, {
    title: t.supportThanksTitle,
    body: `
      <section class="plain-head">
        <h1>${t.supportThanksTitle}</h1>
        <p>${t.supportThanksBody}</p>
        <p><a href="${withLang(req, "/")}">${t.supportThanksBack}</a></p>
      </section>
    `
  });
});

app.get("/donate/cancelled", async (req, res) => {
  const t = getCopy(req);
  await renderPage(req, res, {
    title: t.supportCancelledTitle,
    body: `
      <section class="plain-head">
        <h1>${t.supportCancelledTitle}</h1>
        <p>${t.supportCancelledBody}</p>
        <p><a href="${withLang(req, "/support")}">${t.supportCancelledBack}</a></p>
      </section>
    `
  });
});

app.get("/about", async (req, res) => {
  const t = getCopy(req);
  await renderPage(req, res, {
    title: t.aboutTitle,
    body: `
      <section class="plain-head">
        <h1>${t.aboutTitle}</h1>
        <p>${t.aboutSub}</p>
      </section>
      <article class="policy">
        <h2>${t.aboutWhatHeading}</h2>
        <p>${t.aboutWhatBody}</p>

        <h2>${t.aboutWhyHeading}</h2>
        <p>${t.aboutWhyBody}</p>

        <h2>${t.aboutWhoHeading}</h2>
        <p>${t.aboutWhoBody}</p>

        <h2>${t.aboutHowHeading}</h2>
        <p>${t.aboutHowBody}</p>

        <h2>${t.aboutRulesHeading}</h2>
        <p>${t.aboutRulesBody}</p>

        <h2>${t.aboutRemoveHeading}</h2>
        <p>${t.aboutRemoveBody}</p>
      </article>
    `
  });
});

app.get("/terms", async (req, res) => {
  const t = getCopy(req);
  await renderPage(req, res, {
    title: t.termsTitle,
    body: `
      <section class="plain-head">
        <h1>${t.termsTitle}</h1>
        <p>${t.termsUpdated}</p>
      </section>
      <article class="policy">
        <p>${t.termsIntro}</p>

        <h2>${t.termsWhatHeading}</h2>
        <p>${t.termsWhatBody}</p>

        <h2>${t.termsContentHeading}</h2>
        <p>${t.termsContentBody}</p>

        <h2>${t.termsMarketHeading}</h2>
        <p>${t.termsMarketBody}</p>

        <h2>${t.termsTipsHeading}</h2>
        <p>${t.termsTipsBody}</p>

        <h2>${t.termsWarrantyHeading}</h2>
        <p>${t.termsWarrantyBody}</p>

        <h2>${t.termsLiabilityHeading}</h2>
        <p>${t.termsLiabilityBody}</p>

        <h2>${t.termsAgeHeading}</h2>
        <p>${t.termsAgeBody}</p>

        <h2>${t.termsLawHeading}</h2>
        <p>${t.termsLawBody}</p>

        <h2>${t.termsChangesHeading}</h2>
        <p>${t.termsChangesBody}</p>
      </article>
    `
  });
});

app.get("/terms.html", async (req, res) => {
  res.redirect(301, withLang(req, "/terms"));
});

// -------------------------------------------------------------- marketplace

// Shared with the app's API: one quota per action, whichever surface it
// comes from. The website's 429 is a page, so it registers how to draw one.
const { loginRequestLimit, listingCreateLimit, messageLimit, listingReportLimit } = marketplaceLimits;
marketplaceLimits.setPageRenderer(async (req, res, minutes) => {
  const t = getCopy(req);
  res.status(429);
  await renderPage(req, res, {
    title: t.nope,
    body: `<section class="plain-head"><h1>${t.nope}</h1><p>${escapeHtml(t.marketThrottled.replace("{minutes}", String(minutes)))}</p></section>`
  });
});

/** Logged in at all - enough to read your own inbox or listings. */
function requireUser(req, res, next) {
  if (req.user) return next();
  return res.redirect(withLang(req, `/login?next=${encodeURIComponent(req.originalUrl)}`));
}

/** Logged in and has picked a name - needed for anything another person
 * will see, since a listing or message with no name on it is exactly the
 * anonymity the accounts exist to replace. */
function requireNamedUser(req, res, next) {
  if (!req.user) return requireUser(req, res, next);
  if (!req.user.name) return res.redirect(withLang(req, `/account/name?next=${encodeURIComponent(req.originalUrl)}`));
  return next();
}

/** Builds a URL without ?lang= duplicated - originalUrl already has one. */
function nextFrom(req) {
  return accounts.safeNext(String(req.query.next || req.body?.next || ""));
}

/** A seller carried over from 1.38.0 has an account but no name until
 * they next log in; say so rather than print a blank. */
function shownName(name, t) {
  return name || t.marketNoName;
}

function marketplaceNav(req) {
  const t = getCopy(req);
  return `
    <p class="listing-manage">
      <a class="button" href="${withLang(req, "/marketplace/new")}">${t.marketSellButton}</a>
      ${req.user ? `
        <a class="button button-quiet" href="${withLang(req, "/marketplace/mine")}">${t.marketMine}</a>
        <a class="button button-quiet" href="${withLang(req, "/messages")}">${t.navMessages}</a>
        <a class="button button-quiet" href="${withLang(req, "/account")}">${escapeHtml(req.user.name || t.accountTitle)}</a>`
      : `<a class="button button-quiet" href="${withLang(req, "/login?next=/marketplace")}">${t.loginButton}</a>`}
    </p>`;
}

// ------------------------------------------------------------------ login

app.get("/login", async (req, res) => {
  const t = getCopy(req);
  const next = nextFrom(req);
  if (req.user) return res.redirect(withLang(req, next));
  await renderLogin(req, res, { next });
});

async function renderLogin(req, res, { next, error = "", email = "", status = 200 }) {
  const t = getCopy(req);
  res.status(status);
  await renderPage(req, res, {
    title: t.loginTitle,
    body: `
      <section class="plain-head">
        <h1>${t.loginTitle}</h1>
        <p>${t.loginSub}</p>
      </section>
      ${accounts.isConfigured() ? `
      <form class="form skinny" method="post" action="${withLang(req, "/login")}">
        ${error ? `<p class="upload-error" role="alert">${escapeHtml(error)}</p>` : ""}
        <input type="hidden" name="next" value="${escapeHtml(next)}">
        <label>${t.loginEmailLabel} <input name="email" type="email" required maxlength="254" autocomplete="email" value="${escapeHtml(email)}"></label>
        <button type="submit">${t.loginSend}</button>
        <p class="listing-rules">${t.loginNote}</p>
      </form>` : `<p class="plain-head">${t.marketUnavailable}</p>`}
    `
  });
}

app.post("/login", loginRequestLimit, async (req, res) => {
  const t = getCopy(req);
  const next = nextFrom(req);
  const result = await accounts.requestLogin({ email: req.body?.email, lang: getLang(req), next });
  if (!result.ok) {
    const errors = {
      invalid: [400, t.loginErrEmail],
      throttled: [429, t.loginErrThrottled],
      unconfigured: [503, t.marketUnavailable],
      send: [502, t.loginErrSend]
    };
    const [status, error] = errors[result.reason] || [500, t.loginErrSend];
    return await renderLogin(req, res, { next, error, email: req.body?.email, status });
  }
  await renderPage(req, res, {
    title: t.marketCheckEmailTitle,
    body: `<section class="plain-head">
      <h1>${t.marketCheckEmailTitle}</h1>
      <p>${escapeHtml(t.loginCheckEmail.replace("{email}", result.email))}</p>
    </section>`
  });
});

/** The link in the email lands here. It only shows a button: a GET that
 * logged you in would be spent by the first mail scanner to open it. */
app.get("/login/verify", async (req, res) => {
  const t = getCopy(req);
  const token = String(req.query.token || "");
  res.setHeader("Cache-Control", "no-store");
  if (!(await accounts.tokenIsValid(token))) {
    res.status(400);
    return await renderPage(req, res, {
      title: t.loginBadLinkTitle,
      noindex: true,
      body: `<section class="plain-head"><h1>${t.loginBadLinkTitle}</h1><p>${t.loginBadLinkBody}</p>
        <p><a class="button" href="${withLang(req, "/login")}">${t.loginButton}</a></p></section>`
    });
  }
  await renderPage(req, res, {
    title: t.loginTitle,
    noindex: true,
    body: `<section class="plain-head">
      <h1>${t.loginTitle}</h1>
      <form method="post" action="${withLang(req, "/login/verify")}">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <button type="submit" class="chaos-button">${t.loginConfirmButton}</button>
      </form>
    </section>`
  });
});

app.post("/login/verify", async (req, res) => {
  const t = getCopy(req);
  const login = await accounts.completeLogin(String(req.body?.token || ""));
  if (!login) {
    res.status(400);
    return await renderPage(req, res, {
      title: t.loginBadLinkTitle,
      noindex: true,
      body: `<section class="plain-head"><h1>${t.loginBadLinkTitle}</h1><p>${t.loginBadLinkBody}</p>
        <p><a class="button" href="${withLang(req, "/login")}">${t.loginButton}</a></p></section>`
    });
  }
  req.session.userId = login.userId;
  req.session.lang = login.lang;
  const target = login.hasName ? login.next : `/account/name?next=${encodeURIComponent(login.next)}`;
  res.redirect(303, withLang(req, target));
});

app.post("/logout", (req, res) => {
  delete req.session.userId;
  res.redirect(303, withLang(req, "/marketplace"));
});

// ---------------------------------------------------------------- account

async function renderNameForm(req, res, { error = "", value = "", status = 200 } = {}) {
  const t = getCopy(req);
  res.status(status);
  await renderPage(req, res, {
    title: t.nameTitle,
    noindex: true,
    body: `
      <section class="plain-head">
        <h1>${t.nameTitle}</h1>
        <p>${t.nameSub}</p>
      </section>
      <form class="form skinny" method="post" action="${withLang(req, "/account/name")}">
        ${error ? `<p class="upload-error" role="alert">${escapeHtml(error)}</p>` : ""}
        <input type="hidden" name="next" value="${escapeHtml(nextFrom(req))}">
        <label>${t.nameLabel} <input name="name" required minlength="3" maxlength="24" autocomplete="nickname" value="${escapeHtml(value || req.user.name || "")}">
          <small>${t.nameRules}</small></label>
        <button type="submit">${t.nameSave}</button>
      </form>
    `
  });
}

app.get("/account/name", requireUser, async (req, res) => {
  await renderNameForm(req, res);
});

app.post("/account/name", refuseInputWhilePaused, requireUser, async (req, res) => {
  const t = getCopy(req);
  const result = await accounts.setName(req.user.id, req.body?.name);
  if (!result.ok) {
    return await renderNameForm(req, res, {
      error: result.reason === "taken" ? t.nameTaken : t.nameInvalid,
      value: req.body?.name,
      status: result.reason === "taken" ? 409 : 400
    });
  }
  res.redirect(303, withLang(req, nextFrom(req)));
});

app.get("/account", requireUser, async (req, res) => {
  const t = getCopy(req);
  res.setHeader("Cache-Control", "no-store");
  const blocks = await statements.blocksOf.all(req.user.id);
  await renderPage(req, res, {
    title: t.accountTitle,
    noindex: true,
    body: `
      <section class="plain-head">
        <h1>${t.accountTitle}</h1>
      </section>
      ${marketplaceNav(req)}
      <article class="policy account">
        <h2>${t.nameLabel}</h2>
        <p><b>${escapeHtml(req.user.name || "-")}</b> &middot; <a href="${withLang(req, "/account/name?next=/account")}">${t.accountChangeName}</a></p>

        <h2>${t.loginEmailLabel}</h2>
        <p>${escapeHtml(req.user.email)}<br><small>${t.accountEmailNote}</small></p>

        <h2>${t.accountNotifyHeading}</h2>
        <form method="post" action="${withLang(req, "/account/notify")}" class="inline-form">
          <input type="hidden" name="notify" value="${req.user.notify ? "" : "1"}">
          <p>${req.user.notify ? t.accountNotifyOn : t.accountNotifyOff}</p>
          <button type="submit">${req.user.notify ? t.accountNotifyTurnOff : t.accountNotifyTurnOn}</button>
        </form>

        <h2>${t.blocksHeading}</h2>
        ${blocks.length ? `<ul>${blocks.map((b) => `
          <li>${escapeHtml(shownName(b.name, t))}
            <form method="post" action="${withLang(req, `/account/blocks/${b.user_id}/delete`)}" class="inline-form">
              <button type="submit">${t.unblockButton}</button>
            </form></li>`).join("")}</ul>` : `<p>${t.blocksEmpty}</p>`}

        <h2>${t.accountLeaveHeading}</h2>
        <form method="post" action="${withLang(req, "/logout")}" class="inline-form">
          <button type="submit">${t.logoutButton}</button>
        </form>
        <p>${t.accountDeleteBody}</p>
        <form method="post" action="${withLang(req, "/account/delete")}" class="inline-form" data-confirm="${escapeHtml(t.accountDeleteConfirm)}">
          <button class="danger" type="submit">${t.accountDeleteButton}</button>
        </form>
      </article>
    `
  });
});

app.post("/account/blocks/:id/delete", requireUser, async (req, res) => {
  const other = postIdFrom(req.params.id);
  if (other !== null) await marketplace.unblock(req.user.id, other);
  res.redirect(303, withLang(req, "/account"));
});

app.post("/account/notify", requireUser, async (req, res) => {
  await accounts.setNotify(req.user.id, req.body?.notify === "1");
  res.redirect(303, withLang(req, "/account"));
});

app.post("/account/delete", requireUser, async (req, res) => {
  const t = getCopy(req);
  await accounts.deleteAccount(req.user.id);
  delete req.session.userId;
  await renderPage(req, res, {
    title: t.accountDeletedTitle,
    body: `<section class="plain-head"><h1>${t.accountDeletedTitle}</h1><p>${t.accountDeletedBody}</p></section>`
  });
});

// ------------------------------------------------------------ marketplace

function renderListingCard(listing, req) {
  const t = getCopy(req);
  const title = escapeHtml(listing.title);
  const sold = listing.status === "sold";
  return `
    <a class="card listing-card${sold ? " is-sold" : ""}" href="${withLang(req, `/marketplace/${listing.id}`)}">
      <div class="card-media">
        ${listing.filename ? `<img src="${storage.publicUrl(listing.filename, "")}" alt="${title}" loading="lazy">` : ""}
        ${sold ? `<div class="sold-stamp">${t.marketSold}</div>` : ""}
      </div>
      <strong>${title}</strong>
      <span class="price-tag">${escapeHtml(marketplace.formatPrice(listing.price_cents, getLang(req)))}</span>
    </a>
  `;
}

app.get("/marketplace", async (req, res) => {
  const t = getCopy(req);
  const perPage = 24;
  const total = (await statements.countLiveListings.get()).count;
  const totalPages = Math.max(Math.ceil(total / perPage), 1);
  const page = Math.min(Math.max(Number(req.query.page || 1) || 1, 1), totalPages);
  const listings = await statements.liveListings.all(perPage, (page - 1) * perPage);
  const pageHref = (number) => withLang(req, number === 1 ? "/marketplace" : `/marketplace?page=${number}`);

  await renderPage(req, res, {
    title: t.marketTitle,
    ogDescription: t.marketSub,
    body: `
      <section class="plain-head">
        <h1>${t.marketTitle}</h1>
        <p>${t.marketSub}</p>
      </section>
      ${marketplaceNav(req)}
      <div class="grid">${listings.length ? listings.map((listing) => renderListingCard(listing, req)).join("") : `<p class="empty">${t.marketEmpty}</p>`}</div>
      ${renderPager(page, totalPages, pageHref, t)}
    `
  });
});

async function renderListingForm(req, res, { values = {}, error = "", status = 200 } = {}) {
  const t = getCopy(req);
  res.status(status);
  const mb = Math.round(IMAGE_LIMIT / (1024 * 1024));
  await renderPage(req, res, {
    title: t.marketNewTitle,
    body: `
      <section class="plain-head">
        <h1>${t.marketNewTitle}</h1>
        <p>${t.marketNewSub}</p>
      </section>
      <form class="form" method="post" action="${withLang(req, "/marketplace/new")}" enctype="multipart/form-data">
        ${error ? `<p class="upload-error" role="alert">${escapeHtml(error)}</p>` : ""}
        <label>${t.marketFieldTitle} <input name="title" maxlength="120" required value="${escapeHtml(values.title)}"></label>
        <label>${t.marketFieldDesc} <textarea name="description" maxlength="2000" rows="6">${escapeHtml(values.description)}</textarea></label>
        <label>${t.marketFieldPrice} <input name="price" inputmode="decimal" maxlength="12" placeholder="${escapeHtml(t.marketPriceOffer)}" value="${escapeHtml(values.price)}"></label>
        <label>${t.marketFieldPhoto} <small class="upload-limits">${escapeHtml(t.marketPhotoHint.replace("{limit}", `${mb}MB`))}</small>
          <input name="photo" type="file" required accept="image/jpeg,image/png,image/gif,image/webp"></label>
        <p class="listing-rules">${t.marketSellerNote.replace("{name}", escapeHtml(req.user.name))}</p>
        <p class="listing-rules">${t.marketRulesNote.replace("{terms}", `<a href="${withLang(req, "/terms")}">${t.termsFooterLink}</a>`)}</p>
        <button type="submit">${t.marketSubmit}</button>
      </form>
    `
  });
}

app.get("/marketplace/new", refuseWhilePaused, requireNamedUser, async (req, res) => {
  await renderListingForm(req, res);
});

/** multer, run by hand rather than as route middleware, so a photo that is
 * too big or not an image is answered on this form, in this form's words,
 * instead of falling through to the generic upload error handler - which
 * would quote the 500MB video limit at someone posting a photo. */
function receivePhoto(req, res) {
  return new Promise((resolve) => {
    imageUpload.single("photo")(req, res, (err) => resolve(err || null));
  });
}

app.post("/marketplace/new", refuseWhilePaused, requireNamedUser, listingCreateLimit, async (req, res) => {
  const t = getCopy(req);
  const sender = safety.who(req, { deviceId: req.session.uploaderId, userId: req.user.id });
  if (await safety.bannedKey(sender)) return await renderListingForm(req, res, { error: t.banned, status: 403 });
  const uploadError = await receivePhoto(req, res);
  const values = { title: req.body?.title, description: req.body?.description, price: req.body?.price };
  if (uploadError) {
    storage.discardTemp(req.file);
    // Too big, not an image, or a malformed form are all the sender's
    // problem; anything else is ours and goes to the error handler.
    const classified = classifyUploadError(uploadError, t);
    if (!classified && uploadError.name !== "MulterError") throw uploadError;
    const status = uploadError.code === "LIMIT_FILE_SIZE" ? 413 : classified ? classified.status : 400;
    const message = t.marketErrPhoto.replace("{limit}", `${Math.round(IMAGE_LIMIT / (1024 * 1024))}MB`);
    return await renderListingForm(req, res, { values, error: message, status });
  }

  const result = await marketplace.createListing({ user: req.user, ...values, file: req.file, lang: getLang(req), sender });
  if (!result.ok) {
    const errors = {
      missing: [400, t.marketErrMissing],
      price: [400, t.marketErrPrice],
      storage: [502, t.marketErrStorage]
    };
    const [status, message] = errors[result.reason] || [500, t.marketErrStorage];
    return await renderListingForm(req, res, { values, error: message, status });
  }
  // Held for review: the listing page would 404, so show it in the
  // seller's own list with a word on why it is not up yet.
  if (result.held) return res.redirect(303, withLang(req, "/marketplace/mine?held=1"));
  res.redirect(303, withLang(req, `/marketplace/${result.id}`));
});

app.get("/marketplace/mine", requireUser, async (req, res) => {
  const t = getCopy(req);
  const lang = getLang(req);
  const rows = await statements.listingsForUser.all(req.user.id);
  const statusLabel = (l) => {
    if (l.hidden && l.moderation) return t.marketStatusHeld;
    if (l.hidden) return t.marketStatusHidden;
    if (new Date(l.expires_at) <= new Date()) return t.marketStatusExpired;
    return l.status === "sold" ? t.marketSold : t.marketStatusLive;
  };
  await renderPage(req, res, {
    title: t.marketMine,
    noindex: true,
    body: `
      <section class="plain-head"><h1>${t.marketMine}</h1></section>
      ${marketplaceNav(req)}
      ${req.query.held ? `<p class="listing-notice" role="status">${t.marketHeld}</p>` : ""}
      <div class="table-wrap">
        <table>
          <thead><tr><th>${t.marketFieldTitle}</th><th>${t.adminMarketStatus}</th><th>${t.navMessages}</th><th>${t.marketExpires}</th><th></th></tr></thead>
          <tbody>${rows.length ? rows.map((l) => {
            const live = l.status === "active" && !l.hidden && new Date(l.expires_at) > new Date();
            return `
            <tr${live || l.status === "sold" ? "" : ' class="row-hidden"'}>
              <td><a href="${withLang(req, `/marketplace/${l.id}`)}">${escapeHtml(l.title)}</a><br><small>${escapeHtml(marketplace.formatPrice(l.price_cents, lang))}</small></td>
              <td>${statusLabel(l)}</td>
              <td>${l.conversations ? `<a href="${withLang(req, "/messages")}">${l.conversations}</a>` : "0"}</td>
              <td>${formatDate(l.expires_at)}</td>
              <td>
                ${live ? `<form method="post" action="${withLang(req, `/marketplace/${l.id}/sold`)}" class="inline-form"><button type="submit">${t.marketManageMarkSold}</button></form>` : ""}
                <form method="post" action="${withLang(req, `/marketplace/${l.id}/delete`)}" class="inline-form" data-confirm="${escapeHtml(t.marketManageConfirmDelete)}"><button class="danger" type="submit">${t.marketManageDelete}</button></form>
              </td>
            </tr>`;
          }).join("") : `<tr><td colspan="5">${t.marketMineEmpty}</td></tr>`}</tbody>
        </table>
      </div>
    `
  });
});

app.post("/marketplace/:id/sold", requireUser, async (req, res) => {
  const id = postIdFrom(req.params.id);
  if (id !== null) await marketplace.markSold(id, req.user.id);
  res.redirect(303, withLang(req, "/marketplace/mine"));
});

app.post("/marketplace/:id/delete", requireUser, async (req, res) => {
  const id = postIdFrom(req.params.id);
  if (id !== null) await marketplace.removeOwn(id, req.user.id);
  res.redirect(303, withLang(req, "/marketplace/mine"));
});

/** The message box on a listing. Its offer field is what the "make an
 * offer" price means: the button is a real one now, not a label. */
function messageForm(req, { action, values = {}, error = "", offerAllowed = true, priceHint = null }) {
  const t = getCopy(req);
  return `
    <form class="form message-form" method="post" action="${action}">
      ${error ? `<p class="upload-error" role="alert">${escapeHtml(error)}</p>` : ""}
      ${offerAllowed ? `<label>${t.offerLabel} <input name="offer" inputmode="decimal" maxlength="12" placeholder="${escapeHtml(priceHint || t.offerPlaceholder)}" value="${escapeHtml(values.offer)}"></label>` : ""}
      <label>${t.messageLabel} <textarea name="body" maxlength="2000" rows="4">${escapeHtml(values.body)}</textarea></label>
      <button type="submit">${t.messageSend}</button>
    </form>`;
}

async function renderListing(req, res, listing, { notice = "", error = "", values = {}, status = 200 } = {}) {
  const t = getCopy(req);
  const lang = getLang(req);
  const title = escapeHtml(listing.title);
  const sold = listing.status === "sold";
  const mine = req.user && req.user.id === listing.user_id;
  let contact;
  if (mine) contact = `<p>${t.marketYours} <a href="${withLang(req, "/messages")}">${t.navMessages}</a> &middot; <a href="${withLang(req, "/marketplace/mine")}">${t.marketMine}</a></p>`;
  else if (sold) contact = `<p>${t.marketContactClosed}</p>`;
  else if (!req.user) contact = `<p><a class="button" href="${withLang(req, `/login?next=${encodeURIComponent(`/marketplace/${listing.id}`)}`)}">${t.marketLoginToMessage}</a></p>`;
  else contact = `
    <p class="listing-rules">${t.marketSafety}</p>
    ${messageForm(req, {
      action: withLang(req, `/marketplace/${listing.id}/message`),
      values,
      error,
      priceHint: listing.price_cents ? marketplace.formatMoney(listing.price_cents, lang) : null
    })}`;

  res.status(status);
  await renderPage(req, res, {
    title: listing.title,
    ogDescription: listing.description || t.marketSub,
    body: `
      <article class="post listing${sold ? " is-sold" : ""}">
        <h1>${title}</h1>
        <p class="price-tag price-large">${escapeHtml(marketplace.formatPrice(listing.price_cents, lang))}</p>
        ${notice ? `<p class="listing-notice" role="status">${escapeHtml(notice)}</p>` : ""}
        <div class="listing-photo">
          ${listing.filename ? `<img class="post-image" src="${storage.publicUrl(listing.filename, "")}" alt="${title}">` : ""}
          ${sold ? `<div class="sold-stamp">${t.marketSold}</div>` : ""}
        </div>
        ${listing.description ? `<p class="listing-desc">${escapeHtml(listing.description)}</p>` : ""}
        <p class="listing-meta">${t.marketSeller} <b>${escapeHtml(shownName(listing.seller_name, t))}</b> &middot; ${t.marketPosted} <time>${formatDate(listing.activated_at)}</time> &middot; ${t.marketExpires} <time>${formatDate(listing.expires_at)}</time></p>

        <section class="listing-contact">
          <h2>${listing.price_cents === null && !sold && !mine ? t.offerHeading : t.marketContactHeading}</h2>
          ${contact}
        </section>

        <details class="listing-report">
          <summary>${t.marketReportButton}</summary>
          <form class="form" method="post" action="${withLang(req, `/marketplace/${listing.id}/report`)}">
            <label>${t.reportReasonLabel}
              <select name="reason" required>
                <option value="scam">${t.marketReportScam}</option>
                <option value="prohibited">${t.marketReportProhibited}</option>
                <option value="spam">${t.reportReasonSpam}</option>
                <option value="other">${t.reportReasonOther}</option>
              </select>
            </label>
            <label>${t.reportDetailsLabel}
              <textarea name="details" maxlength="500" rows="3" placeholder="${escapeHtml(t.reportDetailsPlaceholder)}"></textarea>
            </label>
            <button type="submit">${t.reportSubmit}</button>
          </form>
        </details>

        <p><a href="${withLang(req, "/marketplace")}">&larr; ${t.marketBack}</a></p>
      </article>
    `
  });
}

app.get("/marketplace/:id", async (req, res) => {
  const t = getCopy(req);
  const id = postIdFrom(req.params.id);
  const listing = id === null ? null : await statements.listingPublic.get(id);
  if (!listing) return res.status(404).redirect(withLang(req, "/404"));
  await renderListing(req, res, listing, { notice: req.query.reported ? t.marketReported : "" });
});

const messageErrors = (t) => ({
  empty: [400, t.messageErrEmpty],
  offer: [400, t.offerErrAmount],
  closed: [409, t.marketContactClosed],
  own: [400, t.marketYours]
});

app.post("/marketplace/:id/message", refuseInputWhilePaused, requireNamedUser, messageLimit, async (req, res) => {
  const t = getCopy(req);
  const id = postIdFrom(req.params.id);
  const listing = id === null ? null : await statements.listingPublic.get(id);
  if (!listing) return res.status(404).redirect(withLang(req, "/404"));

  const values = { body: req.body?.body, offer: req.body?.offer };
  const result = await marketplace.startConversation({ listingId: id, buyer: req.user, ...values });
  if (result.ok) return res.redirect(303, withLang(req, `/messages/${result.conversationId}`));
  const [status, error] = messageErrors(t)[result.reason] || [500, t.messageErrEmpty];
  await renderListing(req, res, listing, { error, values, status });
});

app.post("/marketplace/:id/report", listingReportLimit, async (req, res) => {
  const id = postIdFrom(req.params.id);
  const filed = id !== null && await marketplace.report({ id, reason: req.body?.reason, details: req.body?.details });
  if (!filed) return res.status(404).redirect(withLang(req, "/404"));
  res.redirect(303, withLang(req, `/marketplace/${id}?reported=1`));
});

// --------------------------------------------------------------- messages

function previewOf(row, t, lang) {
  if (row.last_offer_cents !== null && row.last_offer_cents !== undefined) {
    return t.offerPreview.replace("{amount}", marketplace.formatMoney(row.last_offer_cents, lang));
  }
  const body = String(row.last_body || "");
  return body.length > 90 ? `${body.slice(0, 90)}…` : body;
}

app.get("/messages", requireUser, async (req, res) => {
  const t = getCopy(req);
  const lang = getLang(req);
  res.setHeader("Cache-Control", "no-store");
  const rows = await statements.inboxForUser.all(req.user.id);
  await renderPage(req, res, {
    title: t.navMessages,
    noindex: true,
    body: `
      <section class="plain-head"><h1>${t.inboxTitle}</h1></section>
      ${marketplaceNav(req)}
      <ol class="inbox">
        ${rows.length ? rows.map((c) => `
          <li class="inbox-row${c.unread ? " is-unread" : ""}">
            <a href="${withLang(req, `/messages/${c.id}`)}">
              ${c.filename ? `<img src="${storage.publicUrl(c.filename, "")}" alt="" loading="lazy">` : `<span class="inbox-noimg"></span>`}
              <span class="inbox-text">
                <b>${escapeHtml(c.title)}</b>
                <span>${escapeHtml((c.i_am_buyer ? t.inboxWithSeller : t.inboxWithBuyer).replace("{name}", shownName(c.other_name, t)))}</span>
                <span class="inbox-preview">${escapeHtml(previewOf(c, t, lang))}</span>
              </span>
              <time>${formatDate(c.last_message_at)}</time>
            </a>
          </li>`).join("") : `<li class="empty">${t.inboxEmpty}</li>`}
      </ol>
    `
  });
});

async function loadConversation(req, res) {
  const id = postIdFrom(req.params.id);
  const conversation = id === null ? null : await statements.conversationForUser.get(id, req.user.id);
  if (!conversation) {
    res.status(404).redirect(withLang(req, "/404"));
    return null;
  }
  return conversation;
}

async function renderThread(req, res, conversation, { error = "", values = {}, status = 200, notice = "" } = {}) {
  const t = getCopy(req);
  const lang = getLang(req);
  const messages = await marketplace.openThread(conversation, req.user.id);
  const iAmBuyer = req.user.id === conversation.buyer_id;
  const other = shownName(iAmBuyer ? conversation.seller_name : conversation.buyer_name, t);
  const forSale = conversation.listing_status === "active" && !conversation.listing_hidden;
  const open = conversation.listing_status !== "removed" && !conversation.listing_hidden;

  const offerCard = (m) => {
    const mineOffer = m.sender_id === req.user.id;
    const amount = escapeHtml(marketplace.formatMoney(m.offer_cents, lang));
    const statusText = { pending: t.offerPending, accepted: t.offerAccepted, declined: t.offerDeclined, superseded: t.offerSuperseded }[m.offer_status] || "";
    const canAnswer = !mineOffer && m.offer_status === "pending" && forSale;
    const action = (decision) => withLang(req, `/messages/${conversation.id}/offer/${m.id}?decision=${decision}`);
    return `
      <div class="offer-card offer-${escapeHtml(m.offer_status)}">
        <span class="offer-label">${t.offerCardLabel}</span>
        <span class="offer-amount">${amount}</span>
        <span class="offer-status">${statusText}</span>
        ${canAnswer ? `
          <span class="offer-actions">
            <form method="post" action="${action("accept")}" class="inline-form"><button type="submit">${t.offerAccept}</button></form>
            <form method="post" action="${action("decline")}" class="inline-form"><button type="submit" class="danger">${t.offerDecline}</button></form>
          </span>` : ""}
      </div>`;
  };

  res.status(status);
  res.setHeader("Cache-Control", "no-store");
  await renderPage(req, res, {
    title: conversation.title,
    noindex: true,
    body: `
      <section class="plain-head thread-head">
        <h1>${escapeHtml(conversation.title)}</h1>
        <p>${escapeHtml((iAmBuyer ? t.inboxWithSeller : t.inboxWithBuyer).replace("{name}", other))}
          &middot; ${escapeHtml(marketplace.formatPrice(conversation.price_cents, lang))}
          ${conversation.listing_status === "sold" ? ` &middot; <b>${t.marketSold}</b>` : ""}
          ${open ? ` &middot; <a href="${withLang(req, `/marketplace/${conversation.listing_id}`)}">${t.marketManageView}</a>` : ""}</p>
      </section>
      ${notice ? `<p class="listing-notice" role="status">${escapeHtml(notice)}</p>` : ""}
      <ol class="thread">
        ${messages.map((m) => `
          <li class="bubble ${m.sender_id === req.user.id ? "bubble-mine" : "bubble-theirs"}">
            <span class="bubble-meta"><b>${escapeHtml(shownName(m.sender_name, t))}</b> <time>${formatDate(m.created_at)}</time></span>
            ${m.offer_cents !== null ? offerCard(m) : ""}
            ${m.body ? `<p>${escapeHtml(m.body)}</p>` : ""}
          </li>`).join("")}
      </ol>
      ${open
        ? messageForm(req, { action: withLang(req, `/messages/${conversation.id}`), values, error, offerAllowed: forSale })
        : `<p class="plain-head">${t.threadClosed}</p>`}
      <p class="listing-rules">${t.marketSafety}</p>
      <details class="listing-report">
        <summary>${t.threadReportButton}</summary>
        <form class="form" method="post" action="${withLang(req, `/messages/${conversation.id}/report`)}">
          <p class="listing-rules">${t.threadReportNote}</p>
          <label>${t.reportReasonLabel}
            <select name="reason" required>
              <option value="scam">${t.marketReportScam}</option>
              <option value="harassment">${t.reportReasonHarassment}</option>
              <option value="spam">${t.reportReasonSpam}</option>
              <option value="other">${t.reportReasonOther}</option>
            </select>
          </label>
          <label>${t.reportDetailsLabel}
            <textarea name="details" maxlength="500" rows="3"></textarea>
          </label>
          <button type="submit">${t.reportSubmit}</button>
        </form>
      </details>
      <form method="post" action="${withLang(req, `/messages/${conversation.id}/block`)}" class="inline-form" data-confirm="${escapeHtml(t.blockConfirm.replace("{name}", other))}">
        <button type="submit" class="danger">${escapeHtml(t.blockButton.replace("{name}", other))}</button>
      </form>
      <p><a href="${withLang(req, "/messages")}">&larr; ${t.inboxTitle}</a></p>
    `
  });
}

app.get("/messages/:id", requireUser, async (req, res) => {
  const t = getCopy(req);
  const conversation = await loadConversation(req, res);
  if (!conversation) return;
  await renderThread(req, res, conversation, { notice: req.query.reported ? t.threadReported : "" });
});

app.post("/messages/:id", refuseInputWhilePaused, requireNamedUser, messageLimit, async (req, res) => {
  const t = getCopy(req);
  const conversation = await loadConversation(req, res);
  if (!conversation) return;
  const values = { body: req.body?.body, offer: req.body?.offer };
  const result = await marketplace.postMessage({ conversation, sender: req.user, ...values });
  if (result.ok) return res.redirect(303, withLang(req, `/messages/${conversation.id}`));
  const [status, error] = messageErrors(t)[result.reason] || [500, t.messageErrEmpty];
  await renderThread(req, res, conversation, { error, values, status });
});

app.post("/messages/:id/offer/:messageId", refuseInputWhilePaused, requireNamedUser, messageLimit, async (req, res) => {
  const conversation = await loadConversation(req, res);
  if (!conversation) return;
  const messageId = postIdFrom(req.params.messageId);
  if (messageId !== null) {
    await marketplace.respondToOffer({ conversation, user: req.user, messageId, accept: req.query.decision === "accept" });
  }
  res.redirect(303, withLang(req, `/messages/${conversation.id}`));
});

/** Same block as the app's: enforced inside lib/marketplace.js, so it
 * holds on both. The thread drops out of the blocker's inbox; it can be
 * undone from the account page. */
app.post("/messages/:id/block", requireUser, async (req, res) => {
  const conversation = await loadConversation(req, res);
  if (!conversation) return;
  await marketplace.blockIn(conversation, req.user.id);
  res.redirect(303, withLang(req, "/messages"));
});

app.post("/messages/:id/report", requireUser, listingReportLimit, async (req, res) => {
  const conversation = await loadConversation(req, res);
  if (!conversation) return;
  await marketplace.reportConversation({ conversation, reason: req.body?.reason, details: req.body?.details });
  res.redirect(303, withLang(req, `/messages/${conversation.id}?reported=1`));
});

app.get("/admin", async (req, res) => {
  const t = getCopy(req);
  if (!req.session.isAdmin) {
    return await renderPage(req, res, {
      title: "Admin",
      body: `
        <section class="plain-head">
          <h1>Admin</h1>
          <p>${t.adminHidden}</p>
        </section>
        <form class="form skinny" method="post" action="${withLang(req, "/admin/login")}">
          <label>${t.password} <input name="password" type="password" required></label>
          <button type="submit">${t.enter}</button>
        </form>
      `
    });
  }

  const showReportedOnly = req.query.filter === "reported";
  const showTrash = req.query.filter === "trash";
  const showHeld = req.query.filter === "held";
  const uploads = showTrash
    ? await statements.trashedUploads.all()
    : showHeld
      ? await statements.heldUploads.all()
      : showReportedOnly
      ? await statements.reportedUploadsAdmin.all()
      : await statements.allUploadsAdmin.all();
  // Full rows, not just a tally - what the reporter typed is the whole
  // point of asking for details, and the count alone discarded it.
  // Fetched in one pass rather than per row: on a remote database a query
  // inside the map is a network round trip per post.
  const reportsByPost = new Map();
  await Promise.all(
    uploads.filter((item) => item.report_count > 0).map(async (item) => {
      reportsByPost.set(item.id, await statements.reportsForPost.all(item.id));
    })
  );

  const rows = uploads.map((item) => {
    const reportRows = reportsByPost.get(item.id) || [];

    return `
    <tr>
      <td><input type="checkbox" name="ids" value="${item.id}" form="bulk-form" aria-label="${item.id}" data-bulk-item></td>
      <td>${item.id}</td>
      <td>
        <a href="${withLang(req, `/admin/post/${item.id}`)}">${escapeHtml(item.title)}</a>
        <a class="who-link" href="${withLang(req, `/admin/safety?kind=post&id=${item.id}`)}">${t.safetyWho}</a>
        ${item.moderation && item.hidden ? `<small class="held-reason">${escapeHtml(t.heldBecause)} ${escapeHtml(item.moderation)}</small>` : ""}
      </td>
      <td>${escapeHtml(item.kind)}</td>
      <td>${formatDate(item.created_at)}</td>
      <td>${(item.upvotes || 0)} / ${(item.downvotes || 0)}</td>
      <td>
        ${
          item.report_count > 0
            ? `<strong>${item.report_count}</strong>
               <ul class="report-details">
                 ${reportRows.map((r) => `
                   <li>
                     <b>${escapeHtml(r.reason)}</b>
                     ${r.comment_id ? `<em class="report-on-comment">${t.reportOnComment}</em>` : ""}
                     ${r.details ? `<span class="report-said">&ldquo;${escapeHtml(r.details)}&rdquo;</span>` : `<span class="report-nodetail">${t.reportNoDetails}</span>`}
                     ${r.comment_body ? `<span class="report-quoted">${escapeHtml(r.comment_body.slice(0, 140))}</span>` : ""}
                     <time>${formatDate(r.created_at)}</time>
                   </li>
                 `).join("")}
               </ul>`
            : "0"
        }
        ${item.report_count > 0 ? `
          <form method="post" action="${withLang(req, `/admin/upload/${item.id}/clear-reports`)}">
            <button type="submit" class="clear-reports">${t.clearReports}</button>
          </form>
        ` : ""}
      </td>
      <td>
        <form method="post" action="${withLang(req, `/admin/upload/${item.id}/flags`)}" class="inline-form">
          <label><input type="checkbox" name="hidden" ${item.hidden ? "checked" : ""}> ${t.hide}</label>
          <label><input type="checkbox" name="pinned" ${item.pinned ? "checked" : ""}> ${t.pin}</label>
          <label><input type="checkbox" name="featured" ${item.featured ? "checked" : ""}> ${t.feature}</label>
          <button type="submit">${t.save}</button>
        </form>
      </td>
      <td>
        ${showTrash ? `
          <form method="post" action="${withLang(req, `/admin/upload/${item.id}/restore`)}">
            <button type="submit">${t.restoreButton}</button>
          </form>
          <form method="post" action="${withLang(req, `/admin/upload/${item.id}/purge`)}" data-confirm="${escapeHtml(t.confirmPurge)}">
            <button class="danger" type="submit">${t.purgeButton}</button>
          </form>
          <small class="trash-when">${escapeHtml(t.deletedOn)} ${formatDate(item.deleted_at)}</small>
        ` : `
          <form method="post" action="${withLang(req, `/admin/upload/${item.id}/delete`)}" data-confirm="${escapeHtml(t.confirmDelete)}">
            <button class="danger" type="submit">${t.deleteButton}</button>
          </form>
        `}
      </td>
    </tr>
  `;
  }).join("");

  const [adminTotal, adminVisitors, trashCount, heldCount] = await Promise.all([
    statements.countAllAdmin.get(),
    getTotalVisits(),
    statements.countTrashed.get(),
    statements.countHeld.get()
  ]);
  const trashNote = TRASH_GRACE_DAYS > 0
    ? t.trashNote.replace("{days}", String(TRASH_GRACE_DAYS))
    : t.trashNoteDisabled;

  await renderPage(req, res, {
    title: "Admin",
    body: `
      <section class="plain-head">
        <h1>${t.adminDashboard}</h1>
        <p>${t.totalUploads}: ${adminTotal.count.toLocaleString("en-US")} | ${t.visitors}: ${adminVisitors.toLocaleString("en-US")}</p>
      </section>
      ${adminNav(req, "dashboard")}
      <nav class="sort-switch" aria-label="Filter">
        <a class="${showReportedOnly || showTrash || showHeld ? "" : "active"}" href="${withLang(req, "/admin")}">${t.adminFilterAll}</a>
        <a class="${showHeld ? "active" : ""}" href="${withLang(req, "/admin?filter=held")}">${t.adminFilterHeld}${heldCount.count ? ` (${heldCount.count})` : ""}</a>
        <a class="${showReportedOnly ? "active" : ""}" href="${withLang(req, "/admin?filter=reported")}">${t.adminFilterReported}</a>
        <a class="${showTrash ? "active" : ""}" href="${withLang(req, "/admin?filter=trash")}">${t.adminFilterTrash}${trashCount.count ? ` (${trashCount.count})` : ""}</a>
      </nav>
      ${showTrash ? `<p class="trash-note">${escapeHtml(trashNote)}</p>` : ""}
      ${showTrash && trashCount.count ? `
        <form method="post" action="${withLang(req, "/admin/trash/empty")}" data-confirm="${escapeHtml(t.confirmEmptyTrash.replace("{count}", String(trashCount.count)))}">
          <button class="danger" type="submit">${t.emptyTrash} (${trashCount.count})</button>
        </form>
      ` : ""}
      ${uploads.length ? `
        <form id="bulk-form" class="bulk-bar" method="post" action="${withLang(req, "/admin/bulk")}">
          <input type="hidden" name="filter" value="${showTrash ? "trash" : showHeld ? "held" : showReportedOnly ? "reported" : ""}">
          <span>${t.bulkSelected}</span>
          ${showTrash ? `
            <button type="submit" name="action" value="restore">${t.restoreButton}</button>
            <button class="danger" type="submit" name="action" value="purge" data-confirm="${escapeHtml(t.confirmBulkPurge)}">${t.purgeButton}</button>
          ` : `
            ${showHeld ? `<button type="submit" name="action" value="approve">${t.approveButton}</button>` : ""}
            <button type="submit" name="action" value="hide">${t.hide}</button>
            <button type="submit" name="action" value="unhide">${t.bulkUnhide}</button>
            <button type="submit" name="action" value="pin">${t.pin}</button>
            <button type="submit" name="action" value="unpin">${t.bulkUnpin}</button>
            <button type="submit" name="action" value="feature">${t.feature}</button>
            <button type="submit" name="action" value="unfeature">${t.bulkUnfeature}</button>
            <button class="danger" type="submit" name="action" value="delete" data-confirm="${escapeHtml(t.confirmBulkDelete)}">${t.deleteButton}</button>
          `}
        </form>
      ` : ""}
      <form method="post" action="${withLang(req, "/admin/reset-visits")}" data-confirm="${escapeHtml(t.confirmReset)}">
        <button class="danger" type="submit">${t.resetCounter}</button>
      </form>
      <div class="table-wrap">
        <table>
          <thead><tr><th><input type="checkbox" aria-label="${t.bulkSelectAll}" data-bulk-all></th><th>ID</th><th>${t.titleLabel}</th><th>${t.kind}</th><th>${t.date}</th><th>&#9650;/&#9660;</th><th>${t.reportsColumn}</th><th>${t.flags}</th><th>${t.delete}</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="9">${showTrash ? t.trashEmpty : showHeld ? t.heldEmpty : showReportedOnly ? t.noReports : t.noUploadsYet}</td></tr>`}</tbody>
        </table>
      </div>
      <form method="post" action="${withLang(req, "/admin/logout")}"><button type="submit">${t.logout}</button></form>
    `
  });
});

/** Admin-only preview. The public post route intentionally excludes hidden
 * and deleted rows; moderators still need to inspect those before deciding
 * whether to approve, restore, or remove them. Permanently purged rows are
 * no longer available here. */
app.get("/admin/post/:id", requireAdmin, async (req, res) => {
  const t = getCopy(req);
  const id = postIdFrom(req.params.id);
  const post = id === null ? null : await statements.uploadByIdAny.get(id);
  if (!post) return res.status(404).send("Post not found.");

  const state = post.deleted_at
    ? `${t.adminFilterTrash} — ${formatDate(post.deleted_at)}`
    : post.moderation && post.hidden
      ? `${t.adminFilterHeld}: ${post.moderation}`
      : post.hidden
        ? t.hide
        : "Visible";
  const media = renderMedia(post, { large: true, processingLabel: t.mediaProcessing }, post.title)
    || `<div class="post-story">${escapeHtml(post.description || t.storyFallback)}</div>`;

  await renderPage(req, res, {
    title: `Preview: ${post.title}`,
    body: `
      <section class="plain-head">
        <h1>Admin preview</h1>
        <p>#${post.id} · ${escapeHtml(state)}</p>
        ${adminNav(req, "dashboard")}
        <p><a href="${withLang(req, "/admin")}">Back to admin</a></p>
      </section>
      <article class="post">
        <h2>${escapeHtml(post.title)}</h2>
        ${media}
        ${post.filename && post.description ? `<p>${escapeHtml(post.description)}</p>` : ""}
        <time>${formatDate(post.created_at)}</time>
      </article>
    `
  });
});

app.get("/admin/metrics", requireAdmin, async (req, res) => {
  const t = getCopy(req);
  // Six independent counters - one round trip instead of six.
  const [top, mVisitors, mPosts, mHidden, mVotes, mFiled, mOutstanding, mSubs, mPush, mJobs] = await Promise.all([
    statements.topUploadsAllTime.all(5),
    getTotalVisits(),
    statements.totalUploadsAll.get(),
    statements.totalUploadsHidden.get(),
    statements.totalVotesCast.get(),
    statements.totalReportsFiled.get(),
    statements.totalReportsOutstanding.get(),
    subscribers.counts(),
    push.deviceCount(),
    statements.mediaJobStats.all()
  ]);

  // Rows only exist for statuses that have occurred, so default the rest
  // to zero rather than rendering "undefined waiting".
  const jobs = { pending: 0, processing: 0, done: 0, failed: 0 };
  for (const row of mJobs) jobs[row.status] = row.n;

  await renderPage(req, res, {
    title: t.metricsPageHeading,
    body: `
      <section class="plain-head">
        <h1>${t.metricsPageHeading}</h1>
      </section>
      ${adminNav(req, "metrics")}
      <div class="metrics-grid">
        <div class="metric-tile"><b>${t.metricsVisitors}</b><span>${mVisitors.toLocaleString("en-US")}</span></div>
        <div class="metric-tile"><b>${t.metricsTotalPosts}</b><span>${mPosts.count.toLocaleString("en-US")}</span></div>
        <div class="metric-tile"><b>${t.metricsHiddenPosts}</b><span>${mHidden.count.toLocaleString("en-US")}</span></div>
        <div class="metric-tile"><b>${t.metricsTotalVotes}</b><span>${mVotes.total.toLocaleString("en-US")}</span></div>
        <div class="metric-tile"><b>${t.metricsReportsFiled}</b><span>${mFiled.value.toLocaleString("en-US")}</span></div>
        <div class="metric-tile"><b>${t.metricsReportsOutstanding}</b><span>${mOutstanding.total.toLocaleString("en-US")}</span></div>
        <div class="metric-tile"><b>${t.metricsSubscribers}</b><span>${mSubs.confirmed.toLocaleString("en-US")}</span><small>${t.metricsSubscribersPending.replace("{n}", String(mSubs.total - mSubs.confirmed))}</small></div>
        <div class="metric-tile"><b>${t.metricsPushDevices}</b><span>${mPush.toLocaleString("en-US")}</span><small>${push.isConfigured() ? t.metricsDeliveryOn : t.metricsDeliveryOff}</small></div>
        <div class="metric-tile"><b>${t.metricsMediaQueue}</b><span>${jobs.processing.toLocaleString("en-US")}</span><small>${escapeHtml(t.metricsMediaQueueNote.replace("{pending}", jobs.pending).replace("{failed}", jobs.failed))}</small></div>
      </div>
      <h2>${t.metricsTopPosts}</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>${t.titleLabel}</th><th>&#9650;/&#9660;</th></tr></thead>
          <tbody>${
            top.length
              ? top.map((item) => `
                <tr>
                  <td>${item.id}</td>
                  <td><a href="${withLang(req, `/post/${item.id}`)}">${escapeHtml(item.title)}</a></td>
                  <td>${item.upvotes || 0} / ${item.downvotes || 0}</td>
                </tr>
              `).join("")
              : `<tr><td colspan="3">${t.noUploadsYet}</td></tr>`
          }</tbody>
        </table>
      </div>
    `
  });
});

app.get("/admin/comments", requireAdmin, async (req, res) => {
  const t = getCopy(req);
  const showHeld = req.query.filter === "held";
  const [rows, heldCount] = await Promise.all([
    showHeld ? statements.heldCommentsAdmin.all() : statements.recentCommentsAdmin.all(200),
    statements.countHeldComments.get()
  ]);

  await renderPage(req, res, {
    title: t.adminNavComments,
    body: `
      <section class="plain-head"><h1>${t.commentsPageHeading}</h1></section>
      ${adminNav(req, "comments")}
      <nav class="sort-switch" aria-label="Filter">
        <a class="${showHeld ? "" : "active"}" href="${withLang(req, "/admin/comments")}">${t.adminFilterAll}</a>
        <a class="${showHeld ? "active" : ""}" href="${withLang(req, "/admin/comments?filter=held")}">${t.adminFilterHeld}${heldCount.count ? ` (${heldCount.count})` : ""}</a>
      </nav>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>${t.commentsColumnPost}</th><th>${t.commentsColumnBody}</th><th>${t.date}</th><th>${t.flags}</th></tr></thead>
          <tbody>${
            rows.length
              ? rows.map((c) => `
                  <tr${c.hidden ? ' class="row-hidden"' : ""}>
                    <td>${c.id}</td>
                    <td><a href="${withLang(req, `/post/${c.post_id}`)}">${escapeHtml(c.post_title)}</a></td>
                    <td class="comment-cell">
                      ${escapeHtml(c.body)}
                      <a class="who-link" href="${withLang(req, `/admin/safety?kind=comment&id=${c.id}`)}">${t.safetyWho}</a>
                      ${c.moderation && c.hidden ? `<small class="held-reason">${escapeHtml(t.heldBecause)} ${escapeHtml(c.moderation)}</small>` : ""}
                    </td>
                    <td>${formatDate(c.created_at)}</td>
                    <td>
                      <form method="post" action="${withLang(req, `/admin/comment/${c.id}/toggle`)}" class="inline-form">
                        <button type="submit">${c.hidden ? (c.moderation ? t.approveButton : t.commentUnhide) : t.hide}</button>
                      </form>
                      <form method="post" action="${withLang(req, `/admin/comment/${c.id}/delete`)}" data-confirm="${escapeHtml(t.confirmDeleteComment)}">
                        <button class="danger" type="submit">${t.deleteButton}</button>
                      </form>
                    </td>
                  </tr>
                `).join("")
              : `<tr><td colspan="5">${showHeld ? t.heldEmpty : t.noCommentsYet}</td></tr>`
          }</tbody>
        </table>
      </div>
    `
  });
});

/** The safety log (lib/safety.js): recent submissions, or everything about
 * one item, one address or one device - and the ban list. */
app.get("/admin/safety", requireAdmin, async (req, res) => {
  const t = getCopy(req);
  const { kind, id, ip, device } = req.query;
  const kinds = ["post", "comment", "listing"];
  const [rows, bans] = await Promise.all([
    kinds.includes(kind) && Number(id) > 0
      ? statements.safetyFor.all(kind, Number(id))
      : ip ? statements.safetyByIp.all(String(ip))
        : device ? statements.safetyByDevice.all(String(device))
          : statements.recentSafety.all(200),
    statements.allBans.all()
  ]);
  const scope = kinds.includes(kind) ? `${kind} #${Number(id)}` : ip ? `IP ${ip}` : device ? `device ${device}` : "";
  const targetHref = (r) => r.kind === "post" ? `/post/${r.target_id}` : r.kind === "listing" ? `/admin/marketplace` : `/admin/comments`;
  const banButton = (key, label) => `
    <form method="post" action="${withLang(req, "/admin/ban")}" class="inline-form" data-confirm="${escapeHtml(t.safetyConfirmBan.replace("{key}", key))}">
      <input type="hidden" name="key" value="${escapeHtml(key)}">
      <button class="danger" type="submit">${label}</button>
    </form>`;
  const filter = (param, value) => `<a href="${withLang(req, `/admin/safety?${param}=${encodeURIComponent(value)}`)}">${escapeHtml(value)}</a>`;

  await renderPage(req, res, {
    title: t.adminNavSafety,
    noindex: true,
    body: `
      <section class="plain-head">
        <h1>${t.adminNavSafety}${scope ? ` &middot; ${escapeHtml(scope)}` : ""}</h1>
        <p>${escapeHtml(t.safetyNote.replace("{days}", String(safety.RETENTION_DAYS)))}</p>
      </section>
      ${adminNav(req, "safety")}
      ${scope ? `<p><a href="${withLang(req, "/admin/safety")}">${t.safetyAll}</a></p>` : ""}
      <h2>${t.safetyBans}</h2>
      ${bans.length ? `<ul class="ban-list">${bans.map((b) => `
        <li>
          <code>${escapeHtml(b.key)}</code> ${b.reason ? escapeHtml(b.reason) : ""} <small>${formatDate(b.created_at)}</small>
          <form method="post" action="${withLang(req, "/admin/unban")}" class="inline-form">
            <input type="hidden" name="key" value="${escapeHtml(b.key)}">
            <button type="submit">${t.safetyUnban}</button>
          </form>
        </li>`).join("")}</ul>` : `<p>${t.safetyNoBans}</p>`}
      <div class="table-wrap">
        <table>
          <thead><tr><th>${t.date}</th><th>${t.kind}</th><th>${t.safetyOutcome}</th><th>IP</th><th>${t.safetyDevice}</th><th>${t.safetyBrowser}</th><th></th></tr></thead>
          <tbody>${rows.length ? rows.map((r) => `
            <tr>
              <td>${formatDate(r.created_at)}</td>
              <td>${r.target_id ? `<a href="${withLang(req, targetHref(r))}">${escapeHtml(r.kind)} #${r.target_id}</a>` : escapeHtml(r.kind)}${r.user_id ? `<br><small>${t.safetyAccount} #${r.user_id}</small>` : ""}</td>
              <td>${escapeHtml(r.outcome)}</td>
              <td>${r.ip ? filter("ip", r.ip) : "-"}</td>
              <td>${r.device_id ? filter("device", r.device_id) : "-"}</td>
              <td><small>${escapeHtml(r.user_agent || "-")}${r.lang ? ` &middot; ${escapeHtml(r.lang)}` : ""}</small></td>
              <td>
                ${r.ip ? banButton(`ip:${r.ip}`, t.safetyBanIp) : ""}
                ${r.device_id ? banButton(`device:${r.device_id}`, t.safetyBanDevice) : ""}
              </td>
            </tr>`).join("") : `<tr><td colspan="7">${t.safetyEmpty}</td></tr>`}</tbody>
        </table>
      </div>
    `
  });
});

app.post("/admin/ban", requireAdmin, async (req, res) => {
  await safety.ban(req.body.key, req.body.reason);
  res.redirect(withLang(req, "/admin/safety"));
});

app.post("/admin/unban", requireAdmin, async (req, res) => {
  await safety.unban(req.body.key);
  res.redirect(withLang(req, "/admin/safety"));
});

app.post("/admin/comment/:id/toggle", requireAdmin, async (req, res) => {
  await moderateComment(Number(req.params.id));
  res.redirect(withLang(req, req.get("Referer")?.includes("filter=held") ? "/admin/comments?filter=held" : "/admin/comments"));
});

app.post("/admin/comment/:id/delete", requireAdmin, async (req, res) => {
  await moderateComment(Number(req.params.id), { remove: true });
  res.redirect(withLang(req, "/admin/comments"));
});

app.get("/admin/marketplace", requireAdmin, async (req, res) => {
  const t = getCopy(req);
  const [rows, reported] = await Promise.all([statements.listingsAdmin.all(300), statements.reportedConversations.all()]);
  const lang = getLang(req);
  const action = (path, label, extra = "") => `
    <form method="post" action="${withLang(req, path)}" class="inline-form"${extra}>
      <button type="submit"${/purge|user/.test(path) ? ' class="danger"' : ""}>${label}</button>
    </form>`;

  await renderPage(req, res, {
    title: t.adminNavMarket,
    body: `
      <section class="plain-head"><h1>${t.adminMarketHeading}</h1></section>
      ${adminNav(req, "marketplace")}
      ${reported.length ? `
      <h2>${t.adminReportedConversations}</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>${t.marketFieldTitle}</th><th>${t.adminMarketParticipants}</th><th>${t.reportReasonLabel}</th><th>${t.date}</th></tr></thead>
          <tbody>${reported.map((c) => `
            <tr>
              <td><a href="${withLang(req, `/admin/conversation/${c.id}`)}">${c.id}</a></td>
              <td>${escapeHtml(c.title)}</td>
              <td>${escapeHtml(c.buyer_name)} &harr; ${escapeHtml(c.seller_name)}</td>
              <td>${escapeHtml(c.report_reason)}</td>
              <td>${formatDate(c.reported_at)}</td>
            </tr>`).join("")}</tbody>
        </table>
      </div>` : ""}
      <h2>${t.adminMarketListings}</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>${t.marketFieldTitle}</th><th>${t.adminMarketStatus}</th><th>${t.adminMarketReports}</th><th>${t.adminMarketSeller}</th><th>${t.date}</th><th>${t.flags}</th></tr></thead>
          <tbody>${
            rows.length
              ? rows.map((l) => {
                const live = l.status === "active" || l.status === "sold";
                return `
                  <tr${l.hidden || !live ? ' class="row-hidden"' : ""}>
                    <td>${l.id}</td>
                    <td>${live && !l.hidden ? `<a href="${withLang(req, `/marketplace/${l.id}`)}">${escapeHtml(l.title)}</a>` : escapeHtml(l.title)}
                      <br><small>${escapeHtml(marketplace.formatPrice(l.price_cents, lang))}</small>
                      <a class="who-link" href="${withLang(req, `/admin/safety?kind=listing&id=${l.id}`)}">${t.safetyWho}</a></td>
                    <td>${escapeHtml(l.status)}${l.hidden ? ` &middot; ${t.adminMarketHidden}` : ""}
                      ${l.moderation && l.hidden ? `<small class="held-reason">${escapeHtml(t.heldBecause)} ${escapeHtml(l.moderation)}</small>` : ""}</td>
                    <td>${l.report_count}</td>
                    <td>${escapeHtml(l.seller_name || "-")}<br><small>${escapeHtml(l.seller_email || "")}</small></td>
                    <td>${formatDate(l.created_at)}${l.expires_at ? `<br><small>${t.marketExpires} ${formatDate(l.expires_at)}</small>` : ""}</td>
                    <td>
                      ${action(`/admin/listing/${l.id}/toggle`, l.hidden ? (l.moderation ? t.approveButton : t.commentUnhide) : t.hide)}
                      ${l.report_count ? action(`/admin/listing/${l.id}/clear-reports`, t.adminMarketClearReports) : ""}
                      ${l.status !== "removed" ? action(`/admin/listing/${l.id}/remove`, t.deleteButton) : ""}
                      ${action(`/admin/listing/${l.id}/purge`, t.adminMarketPurge, ` data-confirm="${escapeHtml(t.adminMarketConfirmPurge)}"`)}
                    </td>
                  </tr>`;
              }).join("")
              : `<tr><td colspan="7">${t.adminMarketEmpty}</td></tr>`
          }</tbody>
        </table>
      </div>
    `
  });
});

/** A private conversation, readable by an admin only once one of its two
 * participants has reported it. Reporting is them choosing to show it to
 * us; without that, the inbox is theirs. */
app.get("/admin/conversation/:id", requireAdmin, async (req, res) => {
  const t = getCopy(req);
  const lang = getLang(req);
  const conversation = await statements.conversationAdmin.get(Number(req.params.id));
  if (!conversation || !conversation.reported_at) return res.status(404).redirect(withLang(req, "/404"));
  const messages = await statements.messagesForConversation.all(conversation.id);
  const userLine = (label, name, email, id) => `
    <p>${label}: <b>${escapeHtml(name)}</b> &middot; ${escapeHtml(email)}
      <form method="post" action="${withLang(req, `/admin/user/${id}/delete`)}" class="inline-form" data-confirm="${escapeHtml(t.adminDeleteUserConfirm)}">
        <button class="danger" type="submit">${t.adminDeleteUser}</button>
      </form></p>`;
  await renderPage(req, res, {
    title: `#${conversation.id}`,
    noindex: true,
    body: `
      <section class="plain-head"><h1>${escapeHtml(conversation.title)}</h1>
        <p>${t.reportReasonLabel}: ${escapeHtml(conversation.report_reason)}</p></section>
      ${adminNav(req, "marketplace")}
      ${userLine(t.adminBuyer, conversation.buyer_name, conversation.buyer_email, conversation.buyer_id)}
      ${userLine(t.adminMarketSeller, conversation.seller_name, conversation.seller_email, conversation.seller_id)}
      <ol class="thread">
        ${messages.map((m) => `
          <li class="bubble ${m.sender_id === conversation.buyer_id ? "bubble-theirs" : "bubble-mine"}">
            <span class="bubble-meta"><b>${escapeHtml(m.sender_name)}</b> <time>${formatDate(m.created_at)}</time></span>
            ${m.offer_cents !== null ? `<div class="offer-card"><span class="offer-amount">${escapeHtml(marketplace.formatMoney(m.offer_cents, lang))}</span> <span class="offer-status">${escapeHtml(m.offer_status)}</span></div>` : ""}
            ${m.body ? `<p>${escapeHtml(m.body)}</p>` : ""}
          </li>`).join("")}
      </ol>
      <form method="post" action="${withLang(req, `/admin/conversation/${conversation.id}/dismiss`)}" class="inline-form">
        <button type="submit">${t.adminMarketClearReports}</button>
      </form>
    `
  });
});

app.post("/admin/conversation/:id/dismiss", requireAdmin, async (req, res) => {
  await statements.dismissConversationReport.run(Number(req.params.id));
  res.redirect(withLang(req, "/admin/marketplace"));
});

/** Bans by deleting: the account, its listings and photos, its
 * conversations. They can come back with the same address - there is no
 * blocklist, since keeping one means keeping the address. */
app.post("/admin/user/:id/delete", requireAdmin, async (req, res) => {
  await accounts.deleteAccount(Number(req.params.id));
  res.redirect(withLang(req, "/admin/marketplace"));
});

app.post("/admin/listing/:id/toggle", requireAdmin, async (req, res) => {
  await statements.toggleListingHidden.run(Number(req.params.id));
  res.redirect(withLang(req, "/admin/marketplace"));
});

app.post("/admin/listing/:id/clear-reports", requireAdmin, async (req, res) => {
  await statements.clearListingReports.run(Number(req.params.id));
  res.redirect(withLang(req, "/admin/marketplace"));
});

/** Off the site at once; the row and photo go at the next sweep after the
 * grace period, like a seller's own delete. */
app.post("/admin/listing/:id/remove", requireAdmin, async (req, res) => {
  await statements.adminRemoveListing.run(Number(req.params.id));
  res.redirect(withLang(req, "/admin/marketplace"));
});

/** Gone now, photo included, no undo - for the listing that has to be off
 * the server today rather than in a week. */
app.post("/admin/listing/:id/purge", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const row = await statements.listingByIdAny.get(id);
  if (row?.filename) await storage.remove(row.filename);
  await statements.deleteListing.run(id);
  res.redirect(withLang(req, "/admin/marketplace"));
});

app.get("/admin/settings", requireAdmin, async (req, res) => {
  const t = getCopy(req);
  const smtpConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  const aiConfig = ai.describeConfig();
  const [aiRows, notifyEmail] = await Promise.all([
    statements.allAiContent.all(),
    getNotifyEmail()
  ]);

  await renderPage(req, res, {
    title: t.settingsPageHeading,
    body: `
      <section class="plain-head">
        <h1>${t.settingsPageHeading}</h1>
      </section>
      ${adminNav(req, "settings")}
      <form class="form skinny" method="post" action="${withLang(req, "/admin/settings")}">
        <label>${t.notifyEmailLabel}
          <input type="email" name="notify_email" value="${escapeHtml(notifyEmail || "")}" placeholder="${t.notifyEmailPlaceholder}">
        </label>
        <p class="smtp-status">${smtpConfigured ? t.smtpConfigured : t.smtpNotConfigured}</p>
        <button type="submit">${t.save}</button>
      </form>
      <div class="test-row">
        <button type="button" class="test-btn" data-test="smtp" data-busy="${t.smtpTesting}">${t.smtpTest}</button>
        <output class="test-result" data-test-result="smtp" role="status"></output>
      </div>

      <section class="plain-head"><h2>${t.aiHeading}</h2></section>
      <div class="ai-panel">
        <p class="smtp-status">${
          aiConfig.enabled
            ? t.aiConfigured.replace("{model}", escapeHtml(aiConfig.model)).replace("{host}", escapeHtml(aiConfig.host))
            : t.aiNotConfigured
        }</p>
        <div class="test-row">
          <button type="button" class="test-btn" data-test="ai" data-busy="${t.aiTesting}">${t.aiTest}</button>
          <output class="test-result" data-test-result="ai" role="status"></output>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>${t.aiColumnKey}</th><th>${t.aiColumnLang}</th><th>${t.aiColumnUpdated}</th><th>${t.aiColumnPreview}</th></tr></thead>
            <tbody>${
              aiRows.length
                ? aiRows.map((row) => `
                    <tr>
                      <td>${escapeHtml(row.key)}</td>
                      <td>${escapeHtml(row.lang || "-")}</td>
                      <td>${formatDate(row.updated_at)}</td>
                      <td class="ai-preview">${escapeHtml(row.value.slice(0, 120))}${row.value.length > 120 ? "&hellip;" : ""}</td>
                    </tr>
                  `).join("")
                : `<tr><td colspan="4">${t.aiNoContent}</td></tr>`
            }</tbody>
          </table>
        </div>
        ${aiConfig.enabled ? `
          <form method="post" action="${withLang(req, "/admin/ai/regenerate")}" class="inline-form">
            <button type="submit" name="what" value="content">${t.aiRegenerateContent}</button>
          </form>
          <p class="smtp-status">${t.aiRegenerateNote}</p>
        ` : ""}
      </div>
    `
  });
});

app.post("/admin/settings", requireAdmin, async (req, res) => {
  await setNotifyEmail(String(req.body.notify_email || "").trim().slice(0, 200));
  res.redirect(withLang(req, "/admin/settings"));
});

app.post("/admin/ai/test", requireAdminJson, async (req, res) => {
  try {
    res.json(await ai.testConnection());
  } catch (err) {
    console.error("[ai] test:", err.message);
    res.json({ ok: false, message: `Test threw: ${String(err.message).slice(0, 200)}` });
  }
});

app.post("/admin/smtp/test", requireAdminJson, async (req, res) => {
  try {
    res.json(await sendTestEmail());
  } catch (err) {
    console.error("[mail] test:", err.message);
    res.json({ ok: false, message: `Test threw: ${String(err.message).slice(0, 200)}` });
  }
});

app.post("/admin/ai/regenerate", requireAdmin, async (req, res) => {
  // Kicked off in the background and redirected immediately: on a Pi this
  // takes minutes, and holding the admin's request open that long would
  // just time out somewhere in the proxy chain.
  ai.refreshContent({ force: true }).catch((err) => console.error("[ai]", err.message));
  res.redirect(withLang(req, "/admin/settings"));
});

/** Every other write path on the site was rate limited; this one, the
 * only endpoint guarding an actual password, was not - so it could be
 * guessed at as fast as the network allowed. Ten attempts per 15 minutes
 * turns an overnight brute force into something that would take longer
 * than the universe has been around. */
const loginRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyFn: (req) => getClientIp(req),
  onLimit: async (req, res, retryAfter) => {
    const t = getCopy(req);
    const minutes = Math.ceil(retryAfter / 60);
    res.status(429);
    await renderPage(req, res, {
      title: t.nope,
      body: `<section class="plain-head"><h1>${t.nope}</h1><p>${escapeHtml(t.loginThrottled.replace("{minutes}", String(minutes)))}</p></section>`
    });
  }
});

/** Compares in constant time. A remote timing attack on a password is not
 * a realistic threat over the public internet, but the correct comparison
 * costs nothing and removes the question entirely. Hashing both sides
 * first keeps the compared buffers equal-length, which timingSafeEqual
 * requires and which would otherwise leak the password's length. */
function passwordMatches(given) {
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

app.post("/admin/login", loginRateLimit, async (req, res) => {
  const t = getCopy(req);
  if (passwordMatches(req.body.password)) {
    req.session.isAdmin = true;
    console.warn(`[admin] successful login from ${getClientIp(req)}`);
    return res.redirect(withLang(req, "/admin"));
  }
  // Logged so a burst of these is visible in the container logs even
  // before the rate limiter starts refusing them.
  console.warn(`[admin] failed login from ${getClientIp(req)}`);
  res.status(401);
  return await renderPage(req, res, {
    title: t.nope,
    body: `<section class="plain-head"><h1>${t.nope}</h1><p>${t.badPassword}</p><p><a href="${withLang(req, "/admin")}">${t.tryAgain}</a></p></section>`
  });
});

app.post("/admin/logout", requireAdmin, async (req, res) => {
  req.session.isAdmin = false;
  res.redirect(withLang(req, "/"));
});

app.post("/admin/reset-visits", requireAdmin, async (req, res) => {
  await statements.resetVisits.run();
  req.session.countedVisit = true;
  res.redirect(withLang(req, "/admin"));
});

/** Unhiding a held post is approving it: announced, and the hold reason
 * cleared, however the admin got there. */
async function approveIfHeld(id) {
  const approved = await statements.approveUpload.get(id);
  if (approved) posts.announce(approved);
}

app.post("/admin/upload/:id/flags", requireAdmin, async (req, res) => {
  if (!req.body.hidden) await approveIfHeld(Number(req.params.id));
  // Booleans now, not 0/1 - the columns are real BOOLEAN in Postgres.
  await statements.updateFlag.run(!!req.body.hidden, !!req.body.pinned, !!req.body.featured, Number(req.params.id));
  res.redirect(withLang(req, "/admin"));
});

/** Soft delete: the post leaves the site at once, but the row, its
 * comments, its votes and both copies of its media survive the grace
 * period. Nothing here touches storage - purgeTrash() does that, later,
 * once the mistake window has closed. */
app.post("/admin/upload/:id/delete", requireAdmin, async (req, res) => {
  await statements.softDeleteUpload.get(Number(req.params.id));
  res.redirect(withLang(req, "/admin?filter=trash"));
});

app.post("/admin/upload/:id/restore", requireAdmin, async (req, res) => {
  await statements.restoreUpload.get(Number(req.params.id));
  res.redirect(withLang(req, "/admin?filter=trash"));
});

/** The escape hatch the grace period would otherwise remove: illegal or
 * infringing content has to be able to go now, not in a week. Deletes the
 * media from both buckets - there is no undo past this point. */
app.post("/admin/upload/:id/purge", requireAdmin, async (req, res) => {
  const uploadRow = await statements.uploadByIdAny.get(Number(req.params.id));
  if (uploadRow) await purgeUpload(uploadRow);
  res.redirect(withLang(req, "/admin?filter=trash"));
});

/** Deletes a post for good: the row now, its media and video poster from
 * both buckets in the background. Each file is a delete on MinIO and one
 * on the MEGA mirror, and emptying a full trash in the request took longer
 * than the proxy waits - a 504 for a purge that was in fact going fine.
 * storage.remove() logs a failure rather than throwing, so waiting for it
 * never protected anything - a failed delete leaves a stray file either way.
 *
 * One queue, so a big purge is a steady trickle of deletes rather than a
 * burst of hundreds at the buckets at once. */
let mediaRemovals = Promise.resolve();

async function purgeUpload(row) {
  await statements.deleteUpload.run(row.id);
  const keys = [row.filename, row.poster].filter(Boolean);
  mediaRemovals = mediaRemovals.then(async () => {
    for (const key of keys) await storage.remove(key);
  }).catch((err) => console.error(`[trash] media delete for post ${row.id} failed: ${err.message}`));
}

/** The ticked rows of the admin table, all at once. */
const BULK_FLAGS = {
  hide: ["setHiddenMany", true],
  unhide: ["setHiddenMany", false],
  pin: ["setPinnedMany", true],
  unpin: ["setPinnedMany", false],
  feature: ["setFeaturedMany", true],
  unfeature: ["setFeaturedMany", false]
};

app.post("/admin/bulk", requireAdmin, async (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0);
  const action = String(req.body.action || "");
  const back = ["reported", "trash", "held"].includes(req.body.filter) ? `/admin?filter=${req.body.filter}` : "/admin";

  if (ids.length && BULK_FLAGS[action]) {
    if (action === "unhide") for (const id of ids) await approveIfHeld(id);
    const [statement, value] = BULK_FLAGS[action];
    await statements[statement].run(value, ids);
  } else if (ids.length && action === "approve") {
    // Announced now, not at upload: a held post reached nobody's phone.
    for (const id of ids) await approveIfHeld(id);
  } else if (ids.length && action === "delete") {
    for (const id of ids) await statements.softDeleteUpload.get(id);
  } else if (ids.length && action === "restore") {
    for (const id of ids) await statements.restoreUpload.get(id);
  } else if (ids.length && action === "purge") {
    for (const id of ids) {
      const row = await statements.uploadByIdAny.get(id);
      // Only what is already in the trash: "delete forever" must never be
      // one mis-tick away from a live post.
      if (row?.deleted_at) await purgeUpload(row);
    }
  }
  res.redirect(withLang(req, back));
});

app.post("/admin/trash/empty", requireAdmin, async (req, res) => {
  for (const row of await statements.trashedUploads.all()) await purgeUpload(row);
  res.redirect(withLang(req, "/admin?filter=trash"));
});

app.post("/admin/upload/:id/clear-reports", requireAdmin, async (req, res) => {
  await clearReports(Number(req.params.id));
  res.redirect(withLang(req, req.get("Referer")?.includes("filter=reported") ? "/admin?filter=reported" : "/admin"));
});

app.get("/api/random-phrase", async (req, res) => {
  const t = getCopy(req);
  const phrases = ai.getPhrases(getLang(req));
  res.json({ phrase: phrases[Math.floor(Math.random() * phrases.length)] });
});

/** Both of these used to 302 into /404, so crawlers got nothing at all.
 * Deliberately permissive: /admin is behind a login, and everything else
 * is meant to be found. */
app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(
    [
      "User-agent: *",
      "Allow: /",
      "Disallow: /admin",
      "Disallow: /api/",
      "Disallow: /donate/",
      "",
      `Sitemap: ${getOrigin(req)}/sitemap.xml`,
      ""
    ].join("\n")
  );
});

app.get("/sitemap.xml", async (req, res) => {
  const origin = getOrigin(req);
  const posts = await statements.sitemapUploads.all();
  const urls = [
    { loc: "/", priority: "1.0", changefreq: "daily" },
    { loc: "/gallery", priority: "0.8", changefreq: "daily" },
    { loc: "/upload", priority: "0.5", changefreq: "monthly" },
    { loc: "/marketplace", priority: "0.5", changefreq: "daily" },
    { loc: "/support", priority: "0.4", changefreq: "monthly" },
    { loc: "/about", priority: "0.4", changefreq: "monthly" },
    { loc: "/privacy", priority: "0.2", changefreq: "yearly" },
    { loc: "/terms", priority: "0.2", changefreq: "yearly" },
    ...posts.map((post) => ({
      loc: `/post/${post.id}`,
      priority: "0.6",
      changefreq: "weekly",
      lastmod: toIsoUtc(post.created_at)
    }))
  ];

  const body = urls
    .map(
      (entry) =>
        `  <url><loc>${escapeHtml(origin + entry.loc)}</loc>` +
        (entry.lastmod ? `<lastmod>${entry.lastmod}</lastmod>` : "") +
        `<changefreq>${entry.changefreq}</changefreq><priority>${entry.priority}</priority></url>`
    )
    .join("\n");

  res.type("application/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`
  );
});

/** The hidden page.
 *
 * Not linked from the nav, not in the sitemap, and deliberately NOT in
 * robots.txt - a Disallow line is a signpost, and the one thing a hidden
 * page must not have is a signpost. Reachable by typing the URL, or by
 * finding the almost-invisible link that appears on one post per day.
 *
 * The cap worship count is real and persisted; everything else on the page
 * is nonsense that climbs on its own. */
app.get("/sweat", async (req, res) => {
  const t = getCopy(req);
  const worship = (await statements.capWorship.get())?.value ?? 0;

  const stat = (label, value, note) => `
    <div class="sw-stat">
      <b>${escapeHtml(label)}</b>
      <span data-sw-count="${value}">0</span>
      <small>${escapeHtml(note)}</small>
    </div>`;

  await renderPage(req, res, {
    title: t.sweatTitle,
    bodyClass: "layout-sweat",
    hideStatsBar: true,
    noindex: true,
    body: `
      <div class="sw">
        <p class="sw-warn" role="status">${escapeHtml(t.sweatWarn)}</p>

        <h1 class="sw-name" data-sw-name>${escapeHtml(t.sweatTitle)}</h1>
        <p class="sw-kicker">${escapeHtml(t.sweatKicker)}</p>

        <div class="sw-grid">
          ${stat(t.sweatNetWorth, 4700000000, t.sweatNetWorthNote)}
          ${stat(t.sweatSweatProduced, 11, t.sweatSweatNote)}
          ${stat(t.sweatHours, 128400, t.sweatHoursNote)}
          ${stat(t.sweatLp, 99999, t.sweatLpNote)}
        </div>

        <section class="sw-cap">
          <h2>${escapeHtml(t.sweatCapHeading)}</h2>
          <div class="sw-cap-stage">
            <div class="sw-cap-object" data-sw-cap aria-hidden="true"></div>
          </div>
          <p class="sw-cap-body">${escapeHtml(t.sweatCapBody)}</p>
          <p class="sw-cap-value"><b>${escapeHtml(t.sweatCapValue)}:</b> <span data-sw-capvalue>&infin;</span></p>
          <button type="button" class="sw-worship" data-sw-worship>${escapeHtml(t.sweatCapWorship)}</button>
          <p class="sw-worship-count" data-sw-worship-count role="status">${escapeHtml(t.sweatCapWorshipped.replace("{n}", worship.toLocaleString("en-US")))}</p>
        </section>

        <section class="sw-table">
          <h2>${escapeHtml(t.sweatStatsHeading)}</h2>
          <dl>
            <dt>${escapeHtml(t.sweatStatRank)}</dt><dd>${escapeHtml(t.sweatStatRankValue)}</dd>
            <dt>${escapeHtml(t.sweatStatKda)}</dt><dd>${escapeHtml(t.sweatStatKdaValue)}</dd>
            <dt>${escapeHtml(t.sweatStatMain)}</dt><dd>${escapeHtml(t.sweatStatMainValue)}</dd>
            <dt>${escapeHtml(t.sweatStatCaps)}</dt><dd>${escapeHtml(t.sweatStatCapsValue)}</dd>
          </dl>
        </section>

        <section class="sw-quotes">
          <h2>${escapeHtml(t.sweatQuotesHeading)}</h2>
          <blockquote>${escapeHtml(t.sweatQuote1)}</blockquote>
          <blockquote>${escapeHtml(t.sweatQuote2)}</blockquote>
          <blockquote>${escapeHtml(t.sweatQuote3)}</blockquote>
        </section>

        <p class="sw-back"><a href="${withLang(req, "/")}">${escapeHtml(t.sweatBack)}</a></p>
      </div>`
  });
});

app.get("/health", async (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    visits: await getTotalVisits(),
    uploads: (await statements.totalUploads.get()).count
  });
});

app.get("/404", async (req, res) => {
  const t = getCopy(req);
  res.status(404);
  await renderPage(req, res, {
    title: "404",
    body: `<section class="not-found"><h1>404</h1><p>${t.missingPage}</p><p><a href="${withLang(req, "/")}">${t.goHome}</a></p></section>`
  });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const t = getCopy(req);

  // A failed upload does not use up one of the hour's posts.
  if (req.uploadKeys) posts.releaseUpload(req.uploadKeys);

  // Same classifier as the API handler above, so a rejected upload reads
  // the same whichever of the two catches it.
  const upload = classifyUploadError(err, t);
  if (upload) {
    if (req.file) storage.discardTemp(req.file);
    if (req.path.startsWith("/api/") || wantsJson(req)) return res.status(upload.status).json({ error: upload.message });
    res.status(upload.status);
    return renderPage(req, res, {
      title: t.uploadErrorTitle,
      body: `<section class="plain-head"><h1>${t.uploadErrorTitle}</h1><p>${escapeHtml(upload.message)}</p><p><a href="${withLang(req, "/upload")}">${t.tryAgain}</a></p></section>`
    }).catch(() => { if (!res.headersSent) res.type("text/plain").send(upload.message); });
  }

  console.error(err);
  const intentional = Number.isInteger(err.status) && err.status >= 400 && err.status < 500;
  res.status(intentional ? err.status : 500);
  // Only messages we wrote ourselves are shown. Echoing err.message put
  // raw Postgres errors on the page for anyone who mistyped a URL.
  const message = intentional && err.message ? err.message : t.genericError;

  // An app asking for JSON must not be handed a web page.
  if (req.path.startsWith("/api/")) {
    return res.json({ error: intentional ? message : "Something went wrong." });
  }
  // Rendering the error page reads the database too, so it can fail for
  // the very reason we are here. Degrade to plain text instead of
  // rejecting out of the last handler in the chain.
  renderPage(req, res, {
    title: t.errorTitle,
    body: `<section class="plain-head"><h1>${t.detected}</h1><p>${escapeHtml(message)}</p><p><a href="${withLang(req, "/upload")}">${t.backToUpload}</a></p></section>`
  }).catch((renderErr) => {
    console.error(`[error-page] could not render: ${renderErr.message}`);
    if (!res.headersSent) res.type("text/plain").send(t.genericError);
  });
});

app.use((req, res) => {
  res.redirect(withLang(req, "/404"));
});



/** The schema check and the AI content cache both have to finish before the
 * first request arrives - with sqlite they happened synchronously at require
 * time, but a remote database can't be set up as a side effect of loading a
 * module. Binding the port only after they resolve means the container is
 * never briefly listening-but-broken.
 *
 * A failure here is fatal on purpose: a site that can't reach its database
 * has nothing to serve, and exiting lets Docker's restart policy retry
 * rather than leaving a process up that 500s every request. */
/** How long a deleted post stays recoverable. Set to 0 to go back to the
 * old behaviour of deleting immediately - but note that neither bucket has
 * versioning, so 0 really does mean the media is gone forever. */
const TRASH_GRACE_DAYS = Number(process.env.TRASH_GRACE_DAYS ?? 7);

/** Hard-deletes posts whose grace period has expired, media included.
 * Deliberately serial and small: this runs on a Raspberry Pi sharing a
 * remote bucket, and a burst of parallel deletes buys nothing. */
async function purgeTrash() {
  if (!(TRASH_GRACE_DAYS > 0)) return;
  let rows;
  try {
    rows = await statements.purgeableUploads.all(TRASH_GRACE_DAYS);
  } catch (err) {
    console.error(`[trash] could not list purgeable posts: ${err.message}`);
    return;
  }
  for (const row of rows) {
    try {
      await purgeUpload(row);
      console.log(`[trash] purged post ${row.id} (grace period of ${TRASH_GRACE_DAYS}d expired)`);
    } catch (err) {
      // Leave deleted_at set so the next sweep retries rather than
      // orphaning a row whose media delete half-succeeded.
      console.error(`[trash] purge of post ${row.id} failed: ${err.message}`);
    }
  }
}

async function main() {
  await initDb();
  await ai.start();
  moderation.warmUp();

  // Uploads whose background mirror write was interrupted by a restart
  // leave their temp file behind; this is the moment to clear them.
  await storage.sweepStaleTemp();

  // One sweep for everything with an expiry. The marketplace half runs
  // even with TRASH_GRACE_DAYS=0, which only means "no undo window": a
  // seller's address must still be deleted when their listing ends, and
  // that cannot depend on whether post deletes are recoverable.
  const sweep = async () => {
    await purgeTrash();
    await marketplace.purge(TRASH_GRACE_DAYS);
    await accounts.purge();
    await safety.purge();
  };
  await sweep();
  setInterval(() => { sweep().catch((err) => console.error(`[sweep] failed: ${err.message}`)); }, 6 * 60 * 60 * 1000).unref();
  if (TRASH_GRACE_DAYS > 0) {
    console.log(`[trash] deleted posts are recoverable for ${TRASH_GRACE_DAYS} day(s)`);
  } else {
    console.log("[trash] TRASH_GRACE_DAYS=0 - deletes are immediate and permanent");
  }

  app.listen(PORT, () => {
    console.log(`sejbosejbo.fyi running at http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  // A failed connection often arrives as an AggregateError whose .message
  // is empty, so printing only that gives an operator "[startup] failed:"
  // and nothing to act on. Say what we tried to reach and dump the causes.
  const target = `${process.env.PGHOST || "localhost"}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE || "(no PGDATABASE)"}`;
  console.error(`[startup] failed connecting to postgres at ${target} as ${process.env.PGUSER || "(no PGUSER)"}`);
  if (err.message) console.error(`  ${err.message}`);
  for (const cause of err.errors || []) console.error(`  - ${cause.message}`);
  if (!err.message && !err.errors?.length) console.error(`  ${err}`);
  process.exit(1);
});
