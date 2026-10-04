/**
 * The marketplace as JSON, for the app.
 *
 * Every route here is a thin wrapper: authenticate, call the function in
 * lib/marketplace.js or lib/accounts.js that the website already uses,
 * serialise the answer. No marketplace rule lives in this file - if one
 * did, the website and the app could disagree about what is allowed, and
 * one owner is the only way to make sure they never do. Who may see a
 * conversation is still decided by conversationForUser, as on the web.
 *
 * Contract: sejbosejbo-app/docs/API_REQUEST_marketplace.md. Field names,
 * paths and status codes are what the app is built against.
 *
 * Auth is a bearer token from the emailed-code login, accepted only on
 * these routes and never turned into a cookie. 401 means exactly one
 * thing - "this token is no good" - because the app signs out on it.
 */
const express = require("express");

const i18n = require("./i18n");
const { statements } = require("./db");
const storage = require("./storage");
const accounts = require("./accounts");
const marketplace = require("./marketplace");
const limits = require("./marketplaceLimits");
const { uploadsPaused, imageUpload, classifyUploadError, IMAGE_LIMIT } = require("./upload");
const { getOrigin, toIsoUtc } = require("./util");
const { autoWrapAsync } = require("./asyncRoutes");

const router = autoWrapAsync(express.Router());

function langOf(req) {
  const lang = req.query.lang || req.body?.lang;
  return lang === "sl" ? "sl" : "en";
}

function copyOf(req) {
  return i18n[langOf(req)];
}

function fail(res, status, code, error) {
  return res.status(status).json({ error, code });
}

function idFrom(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function bearerToken(req) {
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,200})\s*$/.exec(String(req.headers.authorization || ""));
  return match ? match[1] : null;
}

/** A token is optional on public routes, but one that is sent has to be
 * good: a revoked token answers 401 everywhere, so the app signs out
 * rather than carrying on half logged in. */
async function optionalUser(req, res, next) {
  req.user = null;
  if (!req.headers.authorization) return next();
  req.token = bearerToken(req);
  req.user = req.token ? await accounts.userForToken(req.token) : null;
  if (!req.user) return fail(res, 401, "unauthorized", copyOf(req).apiErrUnauthorized);
  next();
}

async function requireUser(req, res, next) {
  req.token = bearerToken(req);
  req.user = req.token ? await accounts.userForToken(req.token) : null;
  if (!req.user) return fail(res, 401, "unauthorized", copyOf(req).apiErrUnauthorized);
  next();
}

/** Selling and messaging need a name, as on the website. */
function requireNamed(req, res, next) {
  if (!req.user.name) return fail(res, 403, "name_required", copyOf(req).apiErrNameRequired);
  next();
}

// ------------------------------------------------------------ serialise

async function serializeMe(user) {
  const unread = await statements.unreadConversations.get(user.id);
  return { email: user.email, name: user.name, lang: user.lang, notify: user.notify, unread_count: unread.count };
}

function serializeListing(row, origin, viewer, myConversationId = null) {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? "",
    price_cents: row.price_cents,
    image_url: storage.publicUrl(row.filename, origin),
    status: row.status,
    seller: { name: row.seller_name ?? null },
    created_at: toIsoUtc(row.activated_at || row.created_at),
    expires_at: toIsoUtc(row.expires_at),
    is_mine: Boolean(viewer && viewer.id === row.user_id),
    my_conversation_id: myConversationId
  };
}

function serializeMessage(m, me) {
  return {
    id: Number(m.id),
    mine: m.sender_id === me.id,
    body: m.body,
    offer_cents: m.offer_cents,
    offer_status: m.offer_status,
    created_at: toIsoUtc(m.created_at)
  };
}

/** A row from the inbox query. */
function serializeInboxRow(row, origin, me) {
  return {
    id: row.id,
    role: row.i_am_buyer ? "buyer" : "seller",
    other: { name: row.other_name ?? null },
    listing: {
      id: row.listing_id,
      title: row.title,
      price_cents: row.price_cents,
      image_url: storage.publicUrl(row.filename, origin),
      status: row.listing_status
    },
    last_message: row.last_created_at ? {
      body: row.last_body,
      offer_cents: row.last_offer_cents,
      mine: row.last_sender === me.id,
      created_at: toIsoUtc(row.last_created_at)
    } : null,
    unread: Boolean(row.unread),
    last_message_at: toIsoUtc(row.last_message_at)
  };
}

/** A conversation loaded by conversationForUser, as a thread header.
 * Re-read after any change, so last_message_at is the value the app
 * compares to notice an offer being answered. */
async function serializeConversation(conversation, origin, me) {
  const iAmBuyer = conversation.buyer_id === me.id;
  const last = await statements.lastMessageOf.get(conversation.id);
  const readAt = iAmBuyer ? conversation.buyer_read_at : conversation.seller_read_at;
  return {
    id: conversation.id,
    role: iAmBuyer ? "buyer" : "seller",
    other: { name: (iAmBuyer ? conversation.seller_name : conversation.buyer_name) ?? null },
    listing: {
      id: conversation.listing_id,
      title: conversation.title,
      price_cents: conversation.price_cents,
      image_url: storage.publicUrl(conversation.filename, origin),
      status: conversation.listing_status
    },
    last_message: last ? {
      body: last.body,
      offer_cents: last.offer_cents,
      mine: last.sender_id === me.id,
      created_at: toIsoUtc(last.created_at)
    } : null,
    unread: conversation.last_sender_id !== me.id && new Date(conversation.last_message_at) > new Date(readAt),
    last_message_at: toIsoUtc(conversation.last_message_at)
  };
}

/** How each refusal from lib/marketplace.js reads over the API. */
function messageFailure(res, req, reason) {
  const t = copyOf(req);
  const map = {
    empty: [400, t.messageErrEmpty],
    offer: [400, t.offerErrAmount],
    own: [403, t.marketYours],
    closed: [409, t.marketContactClosed],
    stale: [409, t.offerErrStale]
  };
  const [status, error] = map[reason] || [500, t.apiErrGeneric];
  return fail(res, status, reason, error);
}

// ----------------------------------------------------------------- auth

router.post("/auth/code", limits.loginRequestLimit, async (req, res) => {
  const t = copyOf(req);
  const result = await accounts.requestCode({ email: req.body?.email, lang: langOf(req) });
  if (result.ok) return res.json({ ok: true });
  const map = {
    invalid: [400, t.loginErrEmail],
    throttled: [429, t.loginErrThrottled],
    unconfigured: [503, t.marketUnavailable],
    send: [502, t.loginErrSend]
  };
  const [status, error] = map[result.reason] || [500, t.loginErrSend];
  if (status === 429) {
    // The per-address cap is 15 minutes wide; say so, like the IP limiter.
    res.setHeader("Retry-After", "900");
    return res.status(429).json({ error, code: "rate_limited", retry_after_seconds: 900 });
  }
  return fail(res, status, result.reason, error);
});

router.post("/auth/verify", limits.codeVerifyLimit, async (req, res) => {
  const session = await accounts.verifyCode({ email: req.body?.email, code: req.body?.code });
  if (!session) return fail(res, 400, "bad_code", copyOf(req).codeErrBad);
  const user = await statements.userById.get(session.userId);
  res.json({ token: session.token, user: await serializeMe(user) });
});

router.post("/auth/logout", requireUser, async (req, res) => {
  await accounts.endSession(req.token);
  res.sendStatus(204);
});

// -------------------------------------------------------------- account

router.get("/me", requireUser, async (req, res) => {
  res.json(await serializeMe(req.user));
});

router.patch("/me", requireUser, async (req, res) => {
  const t = copyOf(req);
  const body = req.body || {};
  if (body.name !== undefined) {
    const result = await accounts.setName(req.user.id, typeof body.name === "string" ? body.name : "");
    if (!result.ok) {
      return result.reason === "taken"
        ? fail(res, 409, "taken", t.nameTaken)
        : fail(res, 400, "invalid", t.nameInvalid);
    }
  }
  if (typeof body.notify === "boolean") await accounts.setNotify(req.user.id, body.notify);
  if (body.lang === "sl" || body.lang === "en") await accounts.setLang(req.user.id, body.lang);
  res.json(await serializeMe(await statements.userById.get(req.user.id)));
});

/** Play requires that an account made in the app can be deleted in the
 * app. Same function as the website's button: photos first, then the row,
 * and the cascade takes listings, conversations and app sessions. */
router.delete("/me", requireUser, async (req, res) => {
  await accounts.deleteAccount(req.user.id);
  res.sendStatus(204);
});

router.get("/me/listings", requireUser, async (req, res) => {
  const origin = getOrigin(req);
  const rows = await statements.listingsForUser.all(req.user.id);
  res.json({
    items: rows.map((row) => serializeListing({ ...row, user_id: req.user.id, seller_name: req.user.name }, origin, req.user))
  });
});

router.get("/me/blocks", requireUser, async (req, res) => {
  const rows = await statements.blocksOf.all(req.user.id);
  res.json({ items: rows.map((r) => ({ user_id: r.user_id, name: r.name ?? null, blocked_at: toIsoUtc(r.created_at) })) });
});

router.delete("/me/blocks/:userId", requireUser, async (req, res) => {
  const other = idFrom(req.params.userId);
  if (other !== null) await marketplace.unblock(req.user.id, other);
  res.sendStatus(204);
});

// ------------------------------------------------------------- listings

const SORTS = ["new", "price_asc", "price_desc"];

router.get("/listings", optionalUser, async (req, res) => {
  const origin = getOrigin(req);
  let perPage = Number.parseInt(req.query.per_page, 10);
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 24;
  perPage = Math.min(perPage, 50);
  let page = Number.parseInt(req.query.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  const sort = SORTS.includes(req.query.sort) ? req.query.sort : "new";
  const q = String(req.query.q ?? "").trim().slice(0, 100);
  // ILIKE's own wildcards are escaped, so a search for "50%" means that.
  const pattern = q ? `%${q.replace(/[\\%_]/g, "\\$&")}%` : "";

  const [rows, total] = await Promise.all([
    statements.searchListings.all(perPage, (page - 1) * perPage, pattern, sort),
    statements.countSearchListings.get(pattern)
  ]);
  const mine = new Map();
  if (req.user && rows.length) {
    for (const c of await statements.myConversationsOn.all(req.user.id, rows.map((r) => r.id))) mine.set(c.listing_id, c.id);
  }
  res.json({
    items: rows.map((row) => serializeListing(row, origin, req.user, mine.get(row.id) ?? null)),
    page,
    per_page: perPage,
    total: total.count,
    has_next: page * perPage < total.count,
    sort,
    q
  });
});

router.get("/listings/:id", optionalUser, async (req, res) => {
  const id = idFrom(req.params.id);
  const row = id === null ? null : await statements.listingPublic.get(id);
  if (!row) return fail(res, 404, "not_found", copyOf(req).apiErrNotFound);
  const conversation = req.user ? await statements.myConversationOn.get(row.id, req.user.id) : null;
  res.json(serializeListing(row, getOrigin(req), req.user, conversation?.id ?? null));
});

/** multer by hand, as on the website, so a bad photo is answered here in
 * this API's shape rather than by the generic upload error handler. */
function receivePhoto(req, res) {
  return new Promise((resolve) => {
    imageUpload.single("photo")(req, res, (err) => resolve(err || null));
  });
}

router.post("/listings", requireUser, requireNamed, limits.listingCreateLimit, async (req, res) => {
  const t = copyOf(req);
  if (uploadsPaused()) return fail(res, 503, "uploads_paused", t.uploadsPaused);
  const uploadError = await receivePhoto(req, res);
  if (uploadError) {
    storage.discardTemp(req.file);
    const classified = classifyUploadError(uploadError, t);
    if (!classified && uploadError.name !== "MulterError") throw uploadError;
    const status = uploadError.code === "LIMIT_FILE_SIZE" ? 413 : classified ? classified.status : 400;
    const message = t.marketErrPhoto.replace("{limit}", `${Math.round(IMAGE_LIMIT / (1024 * 1024))}MB`);
    return fail(res, status, status === 413 ? "too_large" : status === 415 ? "unsupported_type" : "missing", message);
  }

  const result = await marketplace.createListing({
    user: req.user,
    title: req.body?.title,
    description: req.body?.description,
    price: req.body?.price,
    file: req.file,
    lang: langOf(req)
  });
  if (!result.ok) {
    const map = {
      missing: [400, t.marketErrMissing],
      price: [400, t.marketErrPrice],
      storage: [503, t.marketErrStorage]
    };
    const [status, error] = map[result.reason] || [500, t.marketErrStorage];
    return fail(res, status, result.reason, error);
  }
  const row = await statements.listingPublic.get(result.id);
  res.status(201).json(serializeListing(row, getOrigin(req), req.user));
});

/** 404 for a listing that doesn't exist (or was deleted), 403 for one
 * that isn't yours - the owner check is the function's, this only tells
 * the two failures apart for the app. */
async function ownListing(req, res) {
  const id = idFrom(req.params.id);
  const row = id === null ? null : await statements.listingByIdAny.get(id);
  if (!row || row.status === "removed") {
    fail(res, 404, "not_found", copyOf(req).apiErrNotFound);
    return null;
  }
  if (row.user_id !== req.user.id) {
    fail(res, 403, "forbidden", copyOf(req).apiErrForbidden);
    return null;
  }
  return row;
}

router.post("/listings/:id/sold", requireUser, async (req, res) => {
  const row = await ownListing(req, res);
  if (!row) return;
  await marketplace.markSold(row.id, req.user.id);
  const listing = await statements.listingPublic.get(row.id);
  if (!listing) return fail(res, 409, "closed", copyOf(req).marketContactClosed);
  res.json(serializeListing(listing, getOrigin(req), req.user));
});

router.delete("/listings/:id", requireUser, async (req, res) => {
  const row = await ownListing(req, res);
  if (!row) return;
  await marketplace.removeOwn(row.id, req.user.id);
  res.sendStatus(204);
});

router.post("/listings/:id/report", optionalUser, limits.listingReportLimit, async (req, res) => {
  const id = idFrom(req.params.id);
  const filed = id !== null && await marketplace.report({ id, reason: req.body?.reason, details: req.body?.details });
  if (!filed) return fail(res, 404, "not_found", copyOf(req).apiErrNotFound);
  res.sendStatus(204);
});

router.post("/listings/:id/messages", requireUser, requireNamed, limits.messageLimit, async (req, res) => {
  const id = idFrom(req.params.id);
  const listing = id === null ? null : await statements.listingPublic.get(id);
  if (!listing) return fail(res, 404, "not_found", copyOf(req).apiErrNotFound);
  const result = await marketplace.startConversation({ listingId: id, buyer: req.user, body: req.body?.body, offer: req.body?.offer });
  if (!result.ok) return messageFailure(res, req, result.reason);
  res.status(201).json({ conversation_id: result.conversationId, message: serializeMessage(result.message, req.user) });
});

// -------------------------------------------------------- conversations

async function loadConversation(req, res) {
  const id = idFrom(req.params.id);
  const conversation = id === null ? null : await statements.conversationForUser.get(id, req.user.id);
  if (!conversation) fail(res, 404, "not_found", copyOf(req).apiErrNotFound);
  return conversation;
}

router.get("/conversations", requireUser, async (req, res) => {
  const origin = getOrigin(req);
  const rows = await statements.inboxForUser.all(req.user.id);
  res.json({ items: rows.map((row) => serializeInboxRow(row, origin, req.user)) });
});

router.get("/conversations/:id", requireUser, async (req, res) => {
  const conversation = await loadConversation(req, res);
  if (!conversation) return;
  const after = req.query.after === undefined ? null : idFrom(req.query.after) ?? 0;
  const messages = await marketplace.openThread(conversation, req.user.id, { after });
  // Re-read: opening may have moved the read marker the header reports.
  const fresh = await statements.conversationForUser.get(conversation.id, req.user.id);
  res.json({
    conversation: await serializeConversation(fresh, getOrigin(req), req.user),
    messages: messages.map((m) => serializeMessage(m, req.user))
  });
});

router.post("/conversations/:id/messages", requireUser, requireNamed, limits.messageLimit, async (req, res) => {
  const conversation = await loadConversation(req, res);
  if (!conversation) return;
  const result = await marketplace.postMessage({ conversation, sender: req.user, body: req.body?.body, offer: req.body?.offer });
  if (!result.ok) return messageFailure(res, req, result.reason);
  res.status(201).json(serializeMessage(result.message, req.user));
});

router.post("/conversations/:id/offers/:messageId", requireUser, requireNamed, limits.messageLimit, async (req, res) => {
  const conversation = await loadConversation(req, res);
  if (!conversation) return;
  const messageId = idFrom(req.params.messageId);
  if (messageId === null || typeof req.body?.accept !== "boolean") {
    return fail(res, 400, "invalid", copyOf(req).apiErrInvalid);
  }
  const result = await marketplace.respondToOffer({ conversation, user: req.user, messageId, accept: req.body.accept });
  if (!result.ok) return messageFailure(res, req, result.reason);
  res.json(serializeMessage(result.message, req.user));
});

router.post("/conversations/:id/report", requireUser, limits.listingReportLimit, async (req, res) => {
  const conversation = await loadConversation(req, res);
  if (!conversation) return;
  await marketplace.reportConversation({ conversation, reason: req.body?.reason, details: req.body?.details });
  res.sendStatus(204);
});

router.post("/conversations/:id/block", requireUser, async (req, res) => {
  const conversation = await loadConversation(req, res);
  if (!conversation) return;
  await marketplace.blockIn(conversation, req.user.id);
  res.sendStatus(204);
});

module.exports = router;
