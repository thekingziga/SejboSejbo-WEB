const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const express = require("express");

const i18n = require("./lib/i18n");
const { rootDir, uploadDir, statements, clearReports } = require("./lib/db");
const {
  getLang,
  getCopy,
  withLang,
  escapeHtml,
  daysSince,
  formatDate,
  getTotalVisits,
  getDailyUpload,
  getOrigin
} = require("./lib/util");
const { upload } = require("./lib/upload");
const apiRouter = require("./lib/api");
const wellKnownRouter = require("./lib/wellKnown");
const donations = require("./lib/donations");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "sejbosejbo";
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

function setSessionCookie(res, sessionData) {
  const value = encodeURIComponent(encodeSession(sessionData));
  res.setHeader("Set-Cookie", `sejbosejbo_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
}

function getStats(req) {
  const t = getCopy(req);
  const latest = statements.latestUpload.get();
  const daily = getDailyUpload();
  return {
    visits: getTotalVisits(),
    uploads: statements.totalUploads.get().count,
    latest,
    daily,
    quote: t.quotes[Math.floor(Math.random() * t.quotes.length)]
  };
}

function renderCard(upload_, req) {
  const t = getCopy(req);
  const title = escapeHtml(upload_.title);
  const description = escapeHtml(upload_.description || "");
  const media = upload_.filename
    ? `<img src="/uploads/${encodeURIComponent(upload_.filename)}" alt="${title}">`
    : `<div class="story-card">${description || t.storyFallback}</div>`;

  return `
    <a class="card" href="${withLang(req, `/post/${upload_.id}`)}">
      <div class="card-media">${media}</div>
      ${upload_.featured ? `<span class="badge">${t.featuredBadge}</span>` : ""}
      <strong>${title}</strong>
      <span>${formatDate(upload_.created_at)}</span>
      <div class="vote-row" data-vote-widget data-post-id="${upload_.id}">
        <button type="button" class="vote-btn vote-up" data-vote="1" aria-label="${t.voteUp}">&#9650; <span data-vote-up>${upload_.upvotes || 0}</span></button>
        <button type="button" class="vote-btn vote-down" data-vote="-1" aria-label="${t.voteDown}">&#9660; <span data-vote-down>${upload_.downvotes || 0}</span></button>
      </div>
    </a>
  `;
}

function layout({ title, body, stats, req }) {
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

  return `<!doctype html>
<html lang="${t.htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle} | sejbosejbo.fyi</title>
  <link rel="icon" type="image/png" href="/public/favicon.png">
  <link rel="apple-touch-icon" href="/public/apple-touch-icon.png">
  <meta name="theme-color" content="#ff66cc">
  <meta name="description" content="${escapeHtml(t.tagline)}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${safeTitle} | sejbosejbo.fyi">
  <meta property="og:description" content="${escapeHtml(t.tagline)}">
  <meta property="og:image" content="${origin}/public/logo.png">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="stylesheet" href="/public/styles.css">
</head>
<body>
  <header class="topbar">
    <a href="${withLang(req, "/")}" class="brand"><img class="brand-mark" src="/public/logo.png" alt="">SEJBOSEJBO</a>
    <nav>
      <a href="${withLang(req, "/gallery")}">${t.navGallery}</a>
      <a href="${withLang(req, "/upload")}">${t.navUpload}</a>
    </nav>
    <div class="language-switch" aria-label="Language switch">
      <a class="${lang === "en" ? "active" : ""}" href="${currentPath}?lang=en">ENG</a>
      <span>/</span>
      <a class="${lang === "sl" ? "active" : ""}" href="${currentPath}?lang=sl">SLO</a>
    </div>
  </header>
  <main>
    ${body}
    <section class="alive">
      <div><b>${t.visitors}:</b> ${stats.visits.toLocaleString("en-US")}</div>
      <div><b>${t.archived}:</b> ${stats.uploads.toLocaleString("en-US")}</div>
      <div><b>${t.daysSince}:</b> ${sinceLast === null ? "&infin;" : sinceLast.toLocaleString("en-US")}</div>
      <div><b>${t.latest}:</b> ${latest}</div>
      <div><b>${t.daily}:</b> ${daily}</div>
      <div><b>${t.randomQuote}:</b> ${escapeHtml(stats.quote)}</div>
    </section>
  </main>
  <footer>
    ${t.official}
    <p class="footer-links"><a href="${withLang(req, "/privacy")}">${t.privacyFooterLink}</a> &middot; <a href="${withLang(req, "/terms")}">${t.termsFooterLink}</a></p>
  </footer>
  <script>
    window.SEJBOSEJBO_COPY = ${JSON.stringify({
      loading: t.loading,
      loadingFailed: t.loadingFailed,
      voteFailed: t.voteFailed,
      reportSubmitted: t.reportSubmitted,
      reportFailed: t.reportFailed,
      appComingSoonMessage: t.appComingSoonMessage
    })};
  </script>
  <script src="/public/main.js"></script>
</body>
</html>`;
}

function renderPage(req, res, options) {
  res.send(layout({ ...options, req, stats: getStats(req) }));
}

function requireAdmin(req, res, next) {
  if (req.session.isAdmin) return next();
  return res.redirect(withLang(req, "/admin"));
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
app.use("/uploads", express.static(uploadDir, { maxAge: "7d" }));

app.use("/.well-known", wellKnownRouter);

app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  req.session = decodeSession(cookies.sejbosejbo_session);
  const originalEnd = res.end.bind(res);
  res.end = (...args) => {
    setSessionCookie(res, req.session);
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
    statements.incrementVisits.run();
    req.session.countedVisit = true;
  }
  next();
});

app.use("/api/v1", apiRouter);

app.get("/", (req, res) => {
  const t = getCopy(req);
  const newest = statements.newestUploads.all(8);
  const cards = newest.length ? newest.map((item) => renderCard(item, req)).join("") : `<p class="empty">${t.emptyHome}</p>`;

  renderPage(req, res, {
    title: t.homeTitle,
    body: `
      <section class="hero">
        <button class="logo-button" type="button" aria-label="Bounce the Sejbosejbo logo"><img class="hero-logo" src="/public/logo.png" alt="">SEJBOSEJBO</button>
        <p class="tagline">${t.tagline}</p>
      </section>

      <section class="examples">
        <p>${t.examples[0]}</p>
        <p>${t.examples[1]}</p>
        <p>${t.examples[2]}</p>
        <p><b>${t.examples[3]}</b></p>
      </section>

      <section class="counter-box">${t.visitorLine} #${getTotalVisits().toLocaleString("en-US")}</section>

      <section class="button-zone">
        <button class="chaos-button" data-random-button type="button">SEJBOSEJBO</button>
        <output class="random-result" data-random-result>${t.pressIt}</output>
      </section>

      <section class="meter">
        <h2>${t.meterTitle}</h2>
        <div class="meter-track"><div class="meter-fill" style="width:${82 + Math.floor(Math.random() * 16)}%"></div></div>
        <p>${t.meterResult}</p>
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

app.get("/gallery", (req, res) => {
  const t = getCopy(req);
  const page = Math.max(Number(req.query.page || 1), 1);
  const perPage = 24;
  const sort = ["newest", "top", "featured"].includes(req.query.sort) ? req.query.sort : "newest";
  const statement = {
    newest: statements.pagedUploads,
    top: statements.pagedUploadsTop,
    featured: statements.pagedUploadsFeatured
  }[sort];
  const rows = statement.all(perPage + 1, (page - 1) * perPage);
  const hasNext = rows.length > perPage;
  const visible = rows.slice(0, perPage);

  const sortLink = (value, label) => {
    const href = withLang(req, `/gallery${value === "newest" ? "" : `?sort=${value}`}`);
    return `<a class="${sort === value ? "active" : ""}" href="${href}">${label}</a>`;
  };

  renderPage(req, res, {
    title: t.galleryTitle,
    body: `
      <section class="plain-head">
        <h1>${t.allUploads}</h1>
        <p>${t.gallerySub}</p>
      </section>
      <nav class="sort-switch" aria-label="Sort">
        ${sortLink("newest", t.sortNewest)}
        ${sortLink("top", t.sortTop)}
        ${sortLink("featured", t.sortFeatured)}
      </nav>
      <div class="grid">${visible.length ? visible.map((item) => renderCard(item, req)).join("") : `<p class="empty">${t.emptyGallery}</p>`}</div>
      <nav class="pager">
        ${page > 1 ? `<a href="${withLang(req, `/gallery?page=${page - 1}${sort === "newest" ? "" : `&sort=${sort}`}`)}">${t.newer}</a>` : ""}
        ${hasNext ? `<a href="${withLang(req, `/gallery?page=${page + 1}${sort === "newest" ? "" : `&sort=${sort}`}`)}">${t.older}</a>` : ""}
      </nav>
    `
  });
});

app.get("/upload", (req, res) => {
  const t = getCopy(req);
  renderPage(req, res, {
    title: t.uploadTitle,
    body: `
      <section class="plain-head">
        <h1>${t.submitTitle}</h1>
        <p>${t.submitSub}</p>
      </section>
      <form class="form" method="post" action="${withLang(req, "/upload")}" enctype="multipart/form-data">
        <label>${t.titleLabel} <input name="title" maxlength="120" required placeholder="${t.titlePlaceholder}"></label>
        <label>${t.descLabel} <textarea name="description" maxlength="1200" rows="6" placeholder="${t.descPlaceholder}"></textarea></label>
        <label>${t.fileLabel} <input name="image" type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-image-input></label>
        <p class="paste-hint">${t.pasteHint}</p>
        <div class="paste-preview" data-paste-preview hidden><img alt=""></div>
        <button type="submit">${t.submitButton}</button>
      </form>
    `
  });
});

app.post("/upload", upload.single("image"), (req, res) => {
  const t = getCopy(req);
  const title = String(req.body.title || "").trim();
  const description = String(req.body.description || "").trim();

  if (!title || (!description && !req.file)) {
    if (req.file) fs.rmSync(req.file.path, { force: true });
    res.status(400);
    return renderPage(req, res, {
      title: t.uploadErrorTitle,
      body: `<section class="plain-head"><h1>${t.notEnough}</h1><p>${t.notEnoughBody}</p><p><a href="${withLang(req, "/upload")}">${t.tryAgain}</a></p></section>`
    });
  }

  const result = statements.insertUpload.run(
    title.slice(0, 120),
    description.slice(0, 1200),
    req.file ? req.file.filename : null,
    req.file ? req.file.originalname : null,
    req.file ? "image" : "story"
  );
  res.redirect(withLang(req, `/post/${result.lastInsertRowid}`));
});

app.get("/post/:id", (req, res) => {
  const t = getCopy(req);
  const post = statements.uploadByIdPublic.get(Number(req.params.id));
  if (!post) return res.status(404).redirect(withLang(req, "/404"));
  const title = escapeHtml(post.title);
  const description = escapeHtml(post.description || "");
  const media = post.filename
    ? `<img class="post-image" src="/uploads/${encodeURIComponent(post.filename)}" alt="${title}">`
    : `<div class="post-story">${description}</div>`;

  renderPage(req, res, {
    title: post.title,
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
    `
  });
});

app.get("/privacy", (req, res) => {
  const t = getCopy(req);
  renderPage(req, res, {
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
app.get("/privacy.html", (req, res) => {
  res.redirect(301, withLang(req, "/privacy"));
});

app.get("/terms", (req, res) => {
  const t = getCopy(req);
  renderPage(req, res, {
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

app.get("/terms.html", (req, res) => {
  res.redirect(301, withLang(req, "/terms"));
});

app.get("/admin", (req, res) => {
  const t = getCopy(req);
  if (!req.session.isAdmin) {
    return renderPage(req, res, {
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
  const uploads = showReportedOnly ? statements.reportedUploadsAdmin.all() : statements.allUploadsAdmin.all();
  const rows = uploads.map((item) => {
    const reasonTally = item.report_count > 0
      ? statements.reportReasonTally.all(item.id).map((r) => `${r.reason} (${r.count})`).join(", ")
      : "";

    return `
    <tr>
      <td>${item.id}</td>
      <td><a href="${withLang(req, `/post/${item.id}`)}">${escapeHtml(item.title)}</a></td>
      <td>${escapeHtml(item.kind)}</td>
      <td>${formatDate(item.created_at)}</td>
      <td>${(item.upvotes || 0)} / ${(item.downvotes || 0)}</td>
      <td>
        ${item.report_count > 0 ? `<strong>${item.report_count}</strong><br><span class="report-tally">${escapeHtml(reasonTally)}</span>` : "0"}
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
        <form method="post" action="${withLang(req, `/admin/upload/${item.id}/delete`)}" onsubmit="return confirm('${t.confirmDelete}')">
          <button class="danger" type="submit">${t.deleteButton}</button>
        </form>
      </td>
    </tr>
  `;
  }).join("");

  renderPage(req, res, {
    title: "Admin",
    body: `
      <section class="plain-head">
        <h1>${t.adminDashboard}</h1>
        <p>${t.totalUploads}: ${statements.allUploadsAdmin.all().length.toLocaleString("en-US")} | ${t.visitors}: ${getTotalVisits().toLocaleString("en-US")}</p>
      </section>
      <nav class="sort-switch" aria-label="Filter">
        <a class="${showReportedOnly ? "" : "active"}" href="${withLang(req, "/admin")}">${t.adminFilterAll}</a>
        <a class="${showReportedOnly ? "active" : ""}" href="${withLang(req, "/admin?filter=reported")}">${t.adminFilterReported}</a>
      </nav>
      <form method="post" action="${withLang(req, "/admin/reset-visits")}" onsubmit="return confirm('${t.confirmReset}')">
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

app.post("/admin/login", (req, res) => {
  const t = getCopy(req);
  if (String(req.body.password || "") === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect(withLang(req, "/admin"));
  }
  res.status(401);
  return renderPage(req, res, {
    title: t.nope,
    body: `<section class="plain-head"><h1>${t.nope}</h1><p>${t.badPassword}</p><p><a href="${withLang(req, "/admin")}">${t.tryAgain}</a></p></section>`
  });
});

app.post("/admin/logout", requireAdmin, (req, res) => {
  req.session.isAdmin = false;
  res.redirect(withLang(req, "/"));
});

app.post("/admin/reset-visits", requireAdmin, (req, res) => {
  statements.resetVisits.run();
  req.session.countedVisit = true;
  res.redirect(withLang(req, "/admin"));
});

app.post("/admin/upload/:id/flags", requireAdmin, (req, res) => {
  statements.updateFlag.run(req.body.hidden ? 1 : 0, req.body.pinned ? 1 : 0, req.body.featured ? 1 : 0, Number(req.params.id));
  res.redirect(withLang(req, "/admin"));
});

app.post("/admin/upload/:id/delete", requireAdmin, (req, res) => {
  const uploadRow = statements.uploadByIdAny.get(Number(req.params.id));
  if (uploadRow?.filename) {
    fs.rmSync(path.join(uploadDir, uploadRow.filename), { force: true });
  }
  statements.deleteUpload.run(Number(req.params.id));
  res.redirect(withLang(req, "/admin"));
});

app.post("/admin/upload/:id/clear-reports", requireAdmin, (req, res) => {
  clearReports(Number(req.params.id));
  res.redirect(withLang(req, req.get("Referer")?.includes("filter=reported") ? "/admin?filter=reported" : "/admin"));
});

app.get("/api/random-phrase", (req, res) => {
  const t = getCopy(req);
  res.json({ phrase: t.phrases[Math.floor(Math.random() * t.phrases.length)] });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    visits: getTotalVisits(),
    uploads: statements.totalUploads.get().count
  });
});

app.get("/404", (req, res) => {
  const t = getCopy(req);
  res.status(404);
  renderPage(req, res, {
    title: "404",
    body: `<section class="not-found"><h1>404</h1><p>${t.missingPage}</p><p><a href="${withLang(req, "/")}">${t.goHome}</a></p></section>`
  });
});

app.use((err, req, res, next) => {
  const t = getCopy(req);
  console.error(err);
  res.status(400);
  renderPage(req, res, {
    title: t.errorTitle,
    body: `<section class="plain-head"><h1>${t.detected}</h1><p>${escapeHtml(err.message || t.genericError)}</p><p><a href="${withLang(req, "/upload")}">${t.backToUpload}</a></p></section>`
  });
});

app.use((req, res) => {
  res.redirect(withLang(req, "/404"));
});

app.listen(PORT, () => {
  console.log(`sejbosejbo.fyi running at http://localhost:${PORT}`);
});
