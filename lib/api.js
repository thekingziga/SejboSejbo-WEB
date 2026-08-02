const fs = require("fs");

const express = require("express");

const i18n = require("./i18n");
const { statements, castVote } = require("./db");
const { getOrigin, getTotalVisits, getDailyUpload, daysSince } = require("./util");
const { getClientIp } = require("./ip");
const { createRateLimiter } = require("./rateLimit");
const { serializePost } = require("./serialize");
const { upload } = require("./upload");
const donations = require("./donations");

const router = express.Router();

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

function getLangParam(req) {
  return req.query.lang === "sl" ? "sl" : "en";
}

// CORS + no-cache for the whole API, ahead of every route below.
router.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Device-Id");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------- reads ---

router.get("/feed", (req, res) => {
  const lang = getLangParam(req);
  const copy = i18n[lang];
  const origin = getOrigin(req);

  const latest = statements.latestUpload.get();
  const posts = statements.newestUploads.all(4).map((row) => serializePost(row, origin));
  const top = statements.topUploadsAllTime.all(3).map((row) => serializePost(row, origin));
  const dailyRow = getDailyUpload();

  res.json({
    stats: {
      visits: getTotalVisits(),
      uploads: statements.totalUploads.get().count,
      days_since_last: daysSince(latest?.created_at)
    },
    quote: copy.quotes[Math.floor(Math.random() * copy.quotes.length)],
    daily: dailyRow ? serializePost(dailyRow, origin) : null,
    posts,
    top
  });
});

router.get("/posts", (req, res) => {
  const origin = getOrigin(req);

  let perPage = Number.parseInt(req.query.per_page, 10);
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 24;
  perPage = Math.min(perPage, 50);

  let page = Number.parseInt(req.query.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  const offset = (page - 1) * perPage;

  const sort = ["newest", "top", "featured"].includes(req.query.sort) ? req.query.sort : "newest";
  const statement = {
    newest: statements.pagedUploads,
    top: statements.pagedUploadsTop,
    featured: statements.pagedUploadsFeatured
  }[sort];

  const rows = statement.all(perPage + 1, offset);
  const hasNext = rows.length > perPage;
  const items = rows.slice(0, perPage).map((row) => serializePost(row, origin));

  res.json({ items, page, per_page: perPage, has_next: hasNext });
});

router.get("/posts/:id", (req, res) => {
  const post = statements.uploadByIdPublic.get(Number(req.params.id));
  if (!post) return res.status(404).json({ error: "Post not found." });
  res.json(serializePost(post, getOrigin(req)));
});

router.get("/random-phrase", (req, res) => {
  const copy = i18n[getLangParam(req)];
  res.json({ phrase: copy.phrases[Math.floor(Math.random() * copy.phrases.length)] });
});

// --------------------------------------------------------------- upload ---

const uploadRateLimit = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyFn: (req) => getClientIp(req),
  message: "Too many uploads from this address. Try again in a few minutes."
});

router.post("/posts", uploadRateLimit, upload.single("image"), (req, res) => {
  const copy = i18n[getLangParam(req)];
  const title = String(req.body.title || "").trim();
  const description = String(req.body.description || "").trim();

  if (!title || (!description && !req.file)) {
    if (req.file) fs.rmSync(req.file.path, { force: true });
    return res.status(400).json({ error: copy.notEnoughBody });
  }

  const result = statements.insertUpload.run(
    title.slice(0, 120),
    description.slice(0, 1200),
    req.file ? req.file.filename : null,
    req.file ? req.file.originalname : null,
    req.file ? "image" : "story"
  );
  const created = statements.uploadByIdAny.get(result.lastInsertRowid);
  res.status(201).json(serializePost(created, getOrigin(req)));
});

// ---------------------------------------------------------------- votes ---

const voteRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyFn: (req) => getClientIp(req),
  message: "Too many votes from this address. Slow down."
});

router.post("/posts/:id/vote", voteRateLimit, (req, res) => {
  const postId = Number(req.params.id);
  const post = statements.uploadByIdPublic.get(postId);
  if (!post) return res.status(404).json({ error: "Post not found." });

  const deviceId = req.headers["x-device-id"];
  if (typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) {
    return res.status(400).json({ error: "Missing or invalid X-Device-Id header." });
  }

  const value = req.body?.value;
  if (value !== 1 && value !== -1 && value !== 0) {
    return res.status(400).json({ error: "value must be 1, -1, or 0." });
  }

  castVote(postId, deviceId, value);
  const updated = statements.uploadByIdPublic.get(postId);
  res.json(serializePost(updated, getOrigin(req)));
});

// ------------------------------------------------------------ donations ---

router.post("/donations/stripe/session", async (req, res, next) => {
  try {
    const tierId = req.body?.tier_id;
    const url = await donations.createStripeCheckoutSession(tierId, getOrigin(req));
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

router.post("/donations/apple/verify", async (req, res, next) => {
  try {
    await donations.verifyAppleReceipt({ productId: req.body?.product_id, token: req.body?.token });
    res.sendStatus(200);
  } catch (err) {
    next(err);
  }
});

router.post("/donations/google/verify", async (req, res, next) => {
  try {
    await donations.verifyGoogleReceipt({ productId: req.body?.product_id, token: req.body?.token });
    res.sendStatus(200);
  } catch (err) {
    next(err);
  }
});

// Note: POST /api/v1/webhooks/stripe is mounted directly on the app, ahead
// of express.json(), because Stripe's signature check needs the raw body -
// see server.js.

// ---------------------------------------------------------- error tail ---

router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 400;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || "Something went wrong." });
});

module.exports = router;
