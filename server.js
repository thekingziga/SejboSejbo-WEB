const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");

const express = require("express");
const compression = require("compression");

const i18n = require("./lib/i18n");
const { rootDir, uploadDir, statements, clearReports, moderateComment, initDb } = require("./lib/db");
const storage = require("./lib/storage");
const {
  getLang,
  getCopy,
  withLang,
  escapeHtml,
  daysSince,
  formatDate,
  getTotalVisits,
  getDailyUpload,
  getOrigin,
  toIsoUtc
} = require("./lib/util");
const { upload, kindForMime, isMediaEnabled, acceptAttribute } = require("./lib/upload");
const apiRouter = require("./lib/api");
const wellKnownRouter = require("./lib/wellKnown");
const donations = require("./lib/donations");
const { getNotifyEmail, setNotifyEmail, sendTestEmail } = require("./lib/mail");
const ai = require("./lib/ai");
const preview = require("./lib/preview");
const { securityHeaders } = require("./lib/security");
const forumHome = require("./lib/forumHome");

/** Post ids from the URL, or null when the path segment is not a whole
 * number. Number() alone yields NaN for "abc" and 1.5 for "1.5", both of
 * which Postgres rejects outright - so /post/abc answered 500 with a raw
 * database error rather than a 404. */
function postIdFrom(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
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
  const [latest, daily, visits, uploads] = await Promise.all([
    statements.latestUpload.get(),
    getDailyUpload(),
    getTotalVisits(),
    statements.totalUploads.get()
  ]);
  return {
    visits,
    uploads: uploads.count,
    latest,
    daily,
    quote: (() => { const q = ai.getQuotes(getLang(req)); return q[Math.floor(Math.random() * q.length)]; })()
  };
}

/** Renders whatever a post's file actually is. kind is set at upload time
 * from the MIME type, so old image rows keep working untouched. */
function renderMedia(row, { large = false } = {}, altText = "") {
  if (!row.filename) return null;
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
  const media = renderMedia(upload_, { large: false }, title)
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

function layout({ title, body, stats, req, ogImage, ogDescription, nonce = "", bodyClass = "", hideStatsBar = false }) {
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
      <a href="${withLang(req, "/support")}">${t.navSupport}</a>
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

    Readable.fromWeb(upstream.body).pipe(res);
  });
}

app.use("/uploads", express.static(uploadDir, { maxAge: "7d" }));

app.use("/.well-known", wellKnownRouter);

app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  req.session = decodeSession(cookies.sejbosejbo_session);
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
      stats: { visits: await getTotalVisits(), uploads: total, votes, comments: commentCount },
      // Reuses the blurred share card as the thumbnail source? No - that
      // would hide the picture from the people already on the site. This
      // is the real image, served through the same path the cards use.
      thumbFor: (post) => (post && post.filename ? storage.publicUrl(post.filename, "") : null),
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

app.get("/upload", async (req, res) => {
  const t = getCopy(req);
  await renderPage(req, res, {
    title: t.uploadTitle,
    body: `
      <section class="plain-head">
        <h1>${t.submitTitle}</h1>
        <p>${t.submitSub}</p>
      </section>
      <form class="form" method="post" action="${withLang(req, "/upload")}" enctype="multipart/form-data">
        <label>${t.titleLabel} <input name="title" maxlength="120" required placeholder="${t.titlePlaceholder}"></label>
        <label>${t.descLabel} <textarea name="description" maxlength="1200" rows="6" placeholder="${t.descPlaceholder}"></textarea></label>
        <label>${isMediaEnabled() ? t.fileLabelMedia : t.fileLabel} <input name="image" type="file" accept="${acceptAttribute()}" data-image-input></label>
        <p class="paste-hint">${t.pasteHint}</p>
        <div class="paste-preview" data-paste-preview hidden><img alt=""></div>
        <button type="submit">${t.submitButton}</button>
      </form>
    `
  });
});

app.post("/upload", upload.single("image"), async (req, res) => {
  const t = getCopy(req);
  const title = String(req.body.title || "").trim();
  const description = String(req.body.description || "").trim();

  if (!title || (!description && !req.file)) {
    storage.discardTemp(req.file);
    res.status(400);
    return await renderPage(req, res, {
      title: t.uploadErrorTitle,
      body: `<section class="plain-head"><h1>${t.notEnough}</h1><p>${t.notEnoughBody}</p><p><a href="${withLang(req, "/upload")}">${t.tryAgain}</a></p></section>`
    });
  }

  // Store the file before the row exists, so a storage failure can't leave
  // a post referencing a missing object.
  try {
    await storage.commit(req.file);
  } catch (err) {
    storage.discardTemp(req.file);
    console.error(`[upload] failed: ${err.message}`);
    res.status(502);
    return await renderPage(req, res, {
      title: t.uploadErrorTitle,
      body: `<section class="plain-head"><h1>${t.notEnough}</h1><p>${t.notEnoughBody}</p><p><a href="${withLang(req, "/upload")}">${t.tryAgain}</a></p></section>`
    });
  }

  const result = await statements.insertUpload.run(
    title.slice(0, 120),
    description.slice(0, 1200),
    req.file ? req.file.filename : null,
    req.file ? req.file.originalname : null,
    req.file ? kindForMime(req.file.mimetype) : "story"
  );
  res.redirect(withLang(req, `/post/${result.lastInsertRowid}`));

  // Most posts are made here rather than through the API, so the
  // announcement has to happen on this path too - notifying only API
  // uploads would mean the website's own posts silently reach nobody.
  // After the redirect and not awaited, for the same reason as in
  // lib/api.js: notifying must not slow down or fail an upload.
  const created = await statements.uploadByIdAny.get(result.lastInsertRowid);
  if (created) {
    Promise.allSettled([push.announcePost(created), subscribers.announcePost(created)])
      .catch((err) => console.error(`[upload] announce failed: ${err.message}`));
  }
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
  const image = post?.filename ? await preview.previewFor(post.filename) : null;
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
  const media = renderMedia(post, { large: true }, title)
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
        <form class="comment-form" data-comment-form>
          <label class="visually-hidden" for="comment-body">${t.commentPlaceholder}</label>
          <textarea id="comment-body" name="body" maxlength="1000" rows="3" required placeholder="${t.commentPlaceholder}"></textarea>
          <div class="comment-actions">
            <button type="submit">${t.commentSubmit}</button>
            <span class="comment-note">${t.commentAnonNote}</span>
          </div>
          <p class="comment-status" data-comment-status role="status"></p>
        </form>
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
          <li>${t.privacyCollectDevice}</li>
          <li>${t.privacyCollectIp}</li>
          <li>${t.privacyCollectVisits}</li>
        </ul>

        <h2>${t.privacyNotCollectHeading}</h2>
        <ul>
          ${t.privacyNotCollectList.map((item) => `<li>${item}</li>`).join("")}
        </ul>

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
  const uploads = showReportedOnly ? await statements.reportedUploadsAdmin.all() : await statements.allUploadsAdmin.all();
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
      <td>${item.id}</td>
      <td><a href="${withLang(req, `/post/${item.id}`)}">${escapeHtml(item.title)}</a></td>
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
        <form method="post" action="${withLang(req, `/admin/upload/${item.id}/delete`)}" data-confirm="${escapeHtml(t.confirmDelete)}">
          <button class="danger" type="submit">${t.deleteButton}</button>
        </form>
      </td>
    </tr>
  `;
  }).join("");

  const [adminTotal, adminVisitors] = await Promise.all([
    statements.countAllAdmin.get(),
    getTotalVisits()
  ]);

  await renderPage(req, res, {
    title: "Admin",
    body: `
      <section class="plain-head">
        <h1>${t.adminDashboard}</h1>
        <p>${t.totalUploads}: ${adminTotal.count.toLocaleString("en-US")} | ${t.visitors}: ${adminVisitors.toLocaleString("en-US")}</p>
      </section>
      ${adminNav(req, "dashboard")}
      <nav class="sort-switch" aria-label="Filter">
        <a class="${showReportedOnly ? "" : "active"}" href="${withLang(req, "/admin")}">${t.adminFilterAll}</a>
        <a class="${showReportedOnly ? "active" : ""}" href="${withLang(req, "/admin?filter=reported")}">${t.adminFilterReported}</a>
      </nav>
      <form method="post" action="${withLang(req, "/admin/reset-visits")}" data-confirm="${escapeHtml(t.confirmReset)}">
        <button class="danger" type="submit">${t.resetCounter}</button>
      </form>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>${t.titleLabel}</th><th>${t.kind}</th><th>${t.date}</th><th>&#9650;/&#9660;</th><th>${t.reportsColumn}</th><th>${t.flags}</th><th>${t.delete}</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="8">${showReportedOnly ? t.noReports : t.noUploadsYet}</td></tr>`}</tbody>
        </table>
      </div>
      <form method="post" action="${withLang(req, "/admin/logout")}"><button type="submit">${t.logout}</button></form>
    `
  });
});

app.get("/admin/metrics", requireAdmin, async (req, res) => {
  const t = getCopy(req);
  // Six independent counters - one round trip instead of six.
  const [top, mVisitors, mPosts, mHidden, mVotes, mFiled, mOutstanding, mSubs, mPush] = await Promise.all([
    statements.topUploadsAllTime.all(5),
    getTotalVisits(),
    statements.totalUploadsAll.get(),
    statements.totalUploadsHidden.get(),
    statements.totalVotesCast.get(),
    statements.totalReportsFiled.get(),
    statements.totalReportsOutstanding.get(),
    subscribers.counts(),
    push.deviceCount()
  ]);

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
  const rows = await statements.recentCommentsAdmin.all(200);

  await renderPage(req, res, {
    title: t.adminNavComments,
    body: `
      <section class="plain-head"><h1>${t.commentsPageHeading}</h1></section>
      ${adminNav(req, "comments")}
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>${t.commentsColumnPost}</th><th>${t.commentsColumnBody}</th><th>${t.date}</th><th>${t.flags}</th></tr></thead>
          <tbody>${
            rows.length
              ? rows.map((c) => `
                  <tr${c.hidden ? ' class="row-hidden"' : ""}>
                    <td>${c.id}</td>
                    <td><a href="${withLang(req, `/post/${c.post_id}`)}">${escapeHtml(c.post_title)}</a></td>
                    <td class="comment-cell">${escapeHtml(c.body)}</td>
                    <td>${formatDate(c.created_at)}</td>
                    <td>
                      <form method="post" action="${withLang(req, `/admin/comment/${c.id}/toggle`)}" class="inline-form">
                        <button type="submit">${c.hidden ? t.commentUnhide : t.hide}</button>
                      </form>
                      <form method="post" action="${withLang(req, `/admin/comment/${c.id}/delete`)}" data-confirm="${escapeHtml(t.confirmDeleteComment)}">
                        <button class="danger" type="submit">${t.deleteButton}</button>
                      </form>
                    </td>
                  </tr>
                `).join("")
              : `<tr><td colspan="5">${t.noCommentsYet}</td></tr>`
          }</tbody>
        </table>
      </div>
    `
  });
});

app.post("/admin/comment/:id/toggle", requireAdmin, async (req, res) => {
  await moderateComment(Number(req.params.id));
  res.redirect(withLang(req, "/admin/comments"));
});

app.post("/admin/comment/:id/delete", requireAdmin, async (req, res) => {
  await moderateComment(Number(req.params.id), { remove: true });
  res.redirect(withLang(req, "/admin/comments"));
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
            <button type="submit" name="what" value="award">${t.aiRegenerateAward}</button>
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
  const what = req.body.what === "award" ? "award" : "content";
  if (what === "award") {
    ai.refreshAward({ force: true }).catch((err) => console.error("[ai]", err.message));
  } else {
    ai.refreshContent({ force: true }).catch((err) => console.error("[ai]", err.message));
  }
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

app.post("/admin/upload/:id/flags", requireAdmin, async (req, res) => {
  // Booleans now, not 0/1 - the columns are real BOOLEAN in Postgres.
  await statements.updateFlag.run(!!req.body.hidden, !!req.body.pinned, !!req.body.featured, Number(req.params.id));
  res.redirect(withLang(req, "/admin"));
});

app.post("/admin/upload/:id/delete", requireAdmin, async (req, res) => {
  const uploadRow = await statements.uploadByIdAny.get(Number(req.params.id));
  if (uploadRow?.filename) {
    await storage.remove(uploadRow.filename);
  }
  await statements.deleteUpload.run(Number(req.params.id));
  res.redirect(withLang(req, "/admin"));
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
    { loc: "/support", priority: "0.4", changefreq: "monthly" },
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
  console.error(err);
  const intentional = Number.isInteger(err.status) && err.status >= 400 && err.status < 500;
  res.status(intentional ? err.status : 500);
  // Only messages we wrote ourselves are shown. Echoing err.message put
  // raw Postgres errors on the page for anyone who mistyped a URL.
  const message = intentional && err.message ? err.message : t.genericError;
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
async function main() {
  await initDb();
  await ai.start();

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
