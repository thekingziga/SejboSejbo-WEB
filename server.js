const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { DatabaseSync } = require("node:sqlite");
const express = require("express");
const multer = require("multer");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "sejbosejbo";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const rootDir = __dirname;
const dataDir = path.join(rootDir, "data");
const uploadDir = path.join(rootDir, "uploads");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "sejbosejbo.sqlite"));
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    filename TEXT,
    original_name TEXT,
    kind TEXT NOT NULL DEFAULT 'image',
    hidden INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    featured INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS counters (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  );

  INSERT OR IGNORE INTO counters (key, value) VALUES ('visits', 0);
`);

const statements = {
  totalVisits: db.prepare("SELECT value FROM counters WHERE key = 'visits'"),
  incrementVisits: db.prepare("UPDATE counters SET value = value + 1 WHERE key = 'visits'"),
  resetVisits: db.prepare("UPDATE counters SET value = 0 WHERE key = 'visits'"),
  totalUploads: db.prepare("SELECT COUNT(*) AS count FROM uploads WHERE hidden = 0"),
  latestUpload: db.prepare("SELECT id, title, created_at FROM uploads WHERE hidden = 0 ORDER BY datetime(created_at) DESC, id DESC LIMIT 1"),
  newestUploads: db.prepare("SELECT * FROM uploads WHERE hidden = 0 ORDER BY pinned DESC, datetime(created_at) DESC, id DESC LIMIT ?"),
  pagedUploads: db.prepare("SELECT * FROM uploads WHERE hidden = 0 ORDER BY pinned DESC, datetime(created_at) DESC, id DESC LIMIT ? OFFSET ?"),
  allUploadsAdmin: db.prepare("SELECT * FROM uploads ORDER BY datetime(created_at) DESC, id DESC"),
  uploadByIdPublic: db.prepare("SELECT * FROM uploads WHERE id = ? AND hidden = 0"),
  uploadByIdAny: db.prepare("SELECT * FROM uploads WHERE id = ?"),
  insertUpload: db.prepare("INSERT INTO uploads (title, description, filename, original_name, kind) VALUES (?, ?, ?, ?, ?)"),
  updateFlag: db.prepare("UPDATE uploads SET hidden = ?, pinned = ?, featured = ? WHERE id = ?"),
  deleteUpload: db.prepare("DELETE FROM uploads WHERE id = ?"),
  dailyPool: db.prepare("SELECT * FROM uploads WHERE hidden = 0 ORDER BY id")
};

const i18n = {
  en: {
    htmlLang: "en",
    phrases: [
      "Certified Sejbosejbo",
      "Peak Sejbosejbo",
      "100% Sejbosejbo",
      "Brain.exe stopped working",
      "Absolutely Sejbosejbo",
      "Legendary Sejbosejbo",
      "Maximum Sejbosejbo achieved",
      "This cannot be unseen",
      "Peak human intelligence",
      "Someone really thought this was a good idea"
    ],
    quotes: [
      "That's a certified Sejbosejbo.",
      "Peak human intelligence.",
      "This cannot be unseen.",
      "Someone really thought this was a good idea.",
      "Absolutely Sejbosejbo.",
      "The vibes were tested. They failed.",
      "No thoughts, just Sejbosejbo."
    ],
    navGallery: "gallery",
    navUpload: "upload",
    visitors: "Visitors",
    archived: "Sejbosejbos Archived",
    daysSince: "Days Since Last Sejbosejbo",
    latest: "Latest Sejbosejbo",
    daily: "Today's Sejbosejbo Award",
    randomQuote: "Random Quote",
    noneYet: "None yet",
    awaiting: "Awaiting first sacrifice",
    official: "This is officially Sejbosejbo.",
    storyFallback: "A text-only Sejbosejbo of mysterious origin.",
    homeTitle: "Home",
    tagline: "Someone just said something so unbelievably stupid... Sejbosejbo.",
    examples: [
      "Someone microwaved ice.",
      "Someone installed Chrome to download Edge.",
      "Someone asked if Wi-Fi is wireless electricity.",
      "Sejbosejbo."
    ],
    visitorLine: "You are visitor",
    pressIt: "Press it. You know you want to.",
    meterTitle: "Sejbometer(TM)",
    meterResult: "Result: Maximum-adjacent Sejbosejbo.",
    newest: "Newest 8 Uploads",
    seeAll: "see all",
    emptyHome: "No uploads yet. Be the first brave soul.",
    galleryTitle: "Gallery",
    allUploads: "All Uploads",
    gallerySub: "Newest first. Most questionable first spiritually.",
    emptyGallery: "The archive is empty. Suspicious.",
    newer: "newer",
    older: "older",
    uploadTitle: "Upload",
    submitTitle: "Submit a Sejbosejbo",
    submitSub: "Image, GIF, or just a cursed text story. Anonymous by design.",
    titleLabel: "Title",
    titlePlaceholder: "Microwaved a salad",
    descLabel: "Description or story",
    descPlaceholder: "What happened? Why was it like this?",
    fileLabel: "Image/GIF",
    submitButton: "submit this Sejbosejbo",
    uploadErrorTitle: "Upload Error",
    notEnough: "Not Sejbosejbo Enough",
    notEnoughBody: "Add a title and either an image/GIF or a story.",
    tryAgain: "try again",
    adminHidden: "Very hidden. Extremely secret. Basically invisible.",
    password: "Password",
    enter: "enter",
    adminDashboard: "Admin Dashboard",
    totalUploads: "Total uploads",
    resetCounter: "reset visit counter",
    kind: "Kind",
    date: "Date",
    flags: "Flags",
    delete: "Delete",
    hide: "hide",
    pin: "pin",
    feature: "feature",
    save: "save",
    deleteButton: "delete",
    noUploadsYet: "No uploads yet.",
    logout: "log out",
    nope: "Nope",
    badPassword: "That password committed Sejbosejbo.",
    onlyImages: "Only images and GIFs are allowed right now.",
    missingPage: "The page you were looking for committed Sejbosejbo.",
    goHome: "go home",
    errorTitle: "Error",
    detected: "Sejbosejbo Detected",
    genericError: "Something went wrong.",
    backToUpload: "back to upload",
    loading: "Measuring Sejbosejbo...",
    loadingFailed: "Calibrating stupidity detector failed.",
    confirmDelete: "Delete this Sejbosejbo forever?",
    confirmReset: "Reset visitor counter?",
    featuredBadge: "* FEATURED"
  },
  sl: {
    htmlLang: "sl",
    phrases: [
      "Certificiran Sejbosejbo",
      "Vrhunski Sejbosejbo",
      "100% Sejbosejbo",
      "Možgani.exe so nehali delati",
      "Absolutno Sejbosejbo",
      "Legendarni Sejbosejbo",
      "Dosežen maksimalni Sejbosejbo",
      "Tega se ne da odvideti",
      "Vrh človeške inteligence",
      "Nekdo je res mislil, da je to dobra ideja"
    ],
    quotes: [
      "To je certificiran Sejbosejbo.",
      "Vrh človeške inteligence.",
      "Tega se ne da odvideti.",
      "Nekdo je res mislil, da je to dobra ideja.",
      "Absolutno Sejbosejbo.",
      "Vajbi so bili testirani. Padli so.",
      "Brez misli, samo Sejbosejbo."
    ],
    navGallery: "galerija",
    navUpload: "naloži",
    visitors: "Obiskovalci",
    archived: "Arhivirani Sejbosejboji",
    daysSince: "Dni od zadnjega Sejbosejboja",
    latest: "Najnovejši Sejbosejbo",
    daily: "Dnevna Sejbosejbo nagrada",
    randomQuote: "Naključni citat",
    noneYet: "Še nič",
    awaiting: "Čakamo prvo žrtvovanje",
    official: "To je uradno Sejbosejbo.",
    storyFallback: "Besedilni Sejbosejbo skrivnostnega izvora.",
    homeTitle: "Domov",
    tagline: "Nekdo je pravkar rekel nekaj tako neverjetno neumnega... Sejbosejbo.",
    examples: [
      "Nekdo je pogrel led v mikrovalovki.",
      "Nekdo je namestil Chrome, da je prenesel Edge.",
      "Nekdo je vprašal, ali je Wi-Fi brezžična elektrika.",
      "Sejbosejbo."
    ],
    visitorLine: "Ti si obiskovalec",
    pressIt: "Pritisni. Saj veš, da hočeš.",
    meterTitle: "Sejbometer(TM)",
    meterResult: "Rezultat: skoraj maksimalni Sejbosejbo.",
    newest: "Najnovejših 8 naloženih",
    seeAll: "poglej vse",
    emptyHome: "Ni še objav. Bodi prva pogumna duša.",
    galleryTitle: "Galerija",
    allUploads: "Vse objave",
    gallerySub: "Najnovejše najprej. Duhovno najbolj vprašljive tudi.",
    emptyGallery: "Arhiv je prazen. Sumljivo.",
    newer: "novejše",
    older: "starejše",
    uploadTitle: "Naloži",
    submitTitle: "Oddaj Sejbosejbo",
    submitSub: "Slika, GIF ali samo prekleta tekstovna zgodba. Anonimno po dizajnu.",
    titleLabel: "Naslov",
    titlePlaceholder: "Pogrel solato v mikrovalovki",
    descLabel: "Opis ali zgodba",
    descPlaceholder: "Kaj se je zgodilo? Zakaj je bilo tako?",
    fileLabel: "Slika/GIF",
    submitButton: "oddaj ta Sejbosejbo",
    uploadErrorTitle: "Napaka pri nalaganju",
    notEnough: "Premalo Sejbosejbo",
    notEnoughBody: "Dodaj naslov in sliko/GIF ali zgodbo.",
    tryAgain: "poskusi znova",
    adminHidden: "Zelo skrito. Ekstremno tajno. Praktično nevidno.",
    password: "Geslo",
    enter: "vstopi",
    adminDashboard: "Admin nadzorna plošča",
    totalUploads: "Skupaj objav",
    resetCounter: "ponastavi stevec obiskov",
    kind: "Tip",
    date: "Datum",
    flags: "Oznake",
    delete: "Izbriši",
    hide: "skrij",
    pin: "pripni",
    feature: "izpostavi",
    save: "shrani",
    deleteButton: "izbriši",
    noUploadsYet: "Ni še objav.",
    logout: "odjava",
    nope: "Ne bo šlo",
    badPassword: "To geslo je naredilo Sejbosejbo.",
    onlyImages: "Trenutno so dovoljene samo slike in GIF-i.",
    missingPage: "Stran, ki si jo iskal, je naredila Sejbosejbo.",
    goHome: "domov",
    errorTitle: "Napaka",
    detected: "Zaznan Sejbosejbo",
    genericError: "Nekaj je šlo narobe.",
    backToUpload: "nazaj na nalaganje",
    loading: "Merim Sejbosejbo...",
    loadingFailed: "Kalibracija detektorja neumnosti ni uspela.",
    confirmDelete: "Izbrišem ta Sejbosejbo za vedno?",
    confirmReset: "Ponastavim stevec obiskov?",
    featuredBadge: "* IZPOSTAVLJENO"
  }
};

function getLang(req) {
  return req.session.lang === "sl" ? "sl" : "en";
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

function daysSince(value) {
  if (!value) return null;
  const then = new Date(`${value}Z`);
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - then.getTime()) / 86400000));
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(`${value}Z`));
}

function getTotalVisits() {
  return statements.totalVisits.get().value;
}

function getDailyUpload() {
  const rows = statements.dailyPool.all();
  if (!rows.length) return null;
  const stamp = new Date().toISOString().slice(0, 10);
  const hash = crypto.createHash("sha1").update(stamp).digest();
  return rows[hash[0] % rows.length];
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

function renderCard(upload, req) {
  const t = getCopy(req);
  const title = escapeHtml(upload.title);
  const description = escapeHtml(upload.description || "");
  const media = upload.filename
    ? `<img src="/uploads/${encodeURIComponent(upload.filename)}" alt="${title}">`
    : `<div class="story-card">${description || t.storyFallback}</div>`;

  return `
    <a class="card" href="${withLang(req, `/post/${upload.id}`)}">
      <div class="card-media">${media}</div>
      ${upload.featured ? `<span class="badge">${t.featuredBadge}</span>` : ""}
      <strong>${title}</strong>
      <span>${formatDate(upload.created_at)}</span>
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
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const origin = escapeHtml(`${proto}://${req.headers.host || "sejbosejbo.fyi"}`);

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
  </footer>
  <script>
    window.SEJBOSEJBO_COPY = ${JSON.stringify({ loading: t.loading, loadingFailed: t.loadingFailed })};
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

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/public", express.static(path.join(rootDir, "public"), { maxAge: "1h" }));
app.use("/uploads", express.static(uploadDir, { maxAge: "7d" }));

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
  if (!req.session.countedVisit) {
    statements.incrementVisits.run();
    req.session.countedVisit = true;
  }
  next();
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error(getCopy(req).onlyImages));
  }
});

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
    `
  });
});

app.get("/gallery", (req, res) => {
  const t = getCopy(req);
  const page = Math.max(Number(req.query.page || 1), 1);
  const perPage = 24;
  const rows = statements.pagedUploads.all(perPage + 1, (page - 1) * perPage);
  const hasNext = rows.length > perPage;
  const visible = rows.slice(0, perPage);

  renderPage(req, res, {
    title: t.galleryTitle,
    body: `
      <section class="plain-head">
        <h1>${t.allUploads}</h1>
        <p>${t.gallerySub}</p>
      </section>
      <div class="grid">${visible.length ? visible.map((item) => renderCard(item, req)).join("") : `<p class="empty">${t.emptyGallery}</p>`}</div>
      <nav class="pager">
        ${page > 1 ? `<a href="${withLang(req, `/gallery?page=${page - 1}`)}">${t.newer}</a>` : ""}
        ${hasNext ? `<a href="${withLang(req, `/gallery?page=${page + 1}`)}">${t.older}</a>` : ""}
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
        <label>${t.fileLabel} <input name="image" type="file" accept="image/png,image/jpeg,image/gif,image/webp"></label>
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
        <h2>${t.official}</h2>
      </article>
    `
  });
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

  const uploads = statements.allUploadsAdmin.all();
  const rows = uploads.map((item) => `
    <tr>
      <td>${item.id}</td>
      <td><a href="${withLang(req, `/post/${item.id}`)}">${escapeHtml(item.title)}</a></td>
      <td>${escapeHtml(item.kind)}</td>
      <td>${formatDate(item.created_at)}</td>
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
  `).join("");

  renderPage(req, res, {
    title: "Admin",
    body: `
      <section class="plain-head">
        <h1>${t.adminDashboard}</h1>
        <p>${t.totalUploads}: ${uploads.length.toLocaleString("en-US")} | ${t.visitors}: ${getTotalVisits().toLocaleString("en-US")}</p>
      </section>
      <form method="post" action="${withLang(req, "/admin/reset-visits")}" onsubmit="return confirm('${t.confirmReset}')">
        <button class="danger" type="submit">${t.resetCounter}</button>
      </form>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>${t.titleLabel}</th><th>${t.kind}</th><th>${t.date}</th><th>${t.flags}</th><th>${t.delete}</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="6">${t.noUploadsYet}</td></tr>`}</tbody>
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
