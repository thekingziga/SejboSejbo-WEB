/**
 * The marketplace: classified ads, and conversations about them.
 *
 * No money moves through the site. Buyer and seller talk here, on the
 * site, under their display names, and settle the deal between themselves.
 * Neither ever sees the other's email address - it is only used to log in
 * and to say "you have a new message".
 *
 * Offers are messages that carry an amount. Only the other side can
 * answer one, and a newer offer in the same conversation replaces any
 * still waiting, so there is never more than one live number on the table.
 *
 * Every function that touches a conversation takes it already loaded by
 * conversationForUser, which only returns it to its two participants.
 * That query is the authorisation; nothing here re-derives it.
 */
const { statements, withTx } = require("./db");
const i18n = require("./i18n");
const storage = require("./storage");
const accounts = require("./accounts");
const { getTransporter, mailFrom, sendReportNotification } = require("./mail");
const { newMessageEmail } = require("./emailTemplate");

const SITE_URL = process.env.SITE_URL || "https://sejbosejbo.fyi";

/** How long a listing stays up once published. */
const LISTING_DAYS = 30;

const TITLE_MAX = 120;
const DESCRIPTION_MAX = 2000;
const MESSAGE_MAX = 2000;
// Seven figures of euros. Anything above is a joke listing, and the site
// can carry the joke in the description instead of in an integer overflow.
const PRICE_MAX_CENTS = 999_999_999;

const REPORT_REASONS = ["scam", "prohibited", "spam", "harassment", "other"];

/** Everything here hangs off email login, so without SMTP the
 * marketplace can be browsed but nobody can sell or talk. */
function isConfigured() {
  return accounts.isConfigured();
}

/** A single line of text: control characters become spaces. Titles end up
 * in email subject lines, where a stray CR/LF is a header injection. */
function oneLine(value, max) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Multi-line text: newlines survive, every other control character does
 * not, and CRLF is normalised so lengths mean the same thing everywhere. */
function multiLine(value, max) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

/** "12", "12.5", "12,50" (Slovenians write a comma) -> cents. Empty means
 * "make an offer" and comes back as null; anything unparseable is an error
 * rather than a guess. */
function parsePrice(raw) {
  const text = String(raw ?? "").trim().replace(/\s/g, "").replace(/€/g, "");
  if (!text) return { ok: true, cents: null };
  const match = /^(\d{1,7})(?:[.,](\d{1,2}))?$/.exec(text);
  if (!match) return { ok: false };
  const cents = Number(match[1]) * 100 + Number((match[2] || "0").padEnd(2, "0"));
  if (cents > PRICE_MAX_CENTS) return { ok: false };
  return { ok: true, cents };
}

function formatMoney(cents, lang) {
  return new Intl.NumberFormat(lang === "sl" ? "sl-SI" : "en-IE", { style: "currency", currency: "EUR" }).format(cents / 100);
}

/** A listing's asking price as shown: an amount, "free", or "make an
 * offer" when the seller left it open. */
function formatPrice(cents, lang) {
  const copy = i18n[lang === "sl" ? "sl" : "en"];
  if (cents === null || cents === undefined) return copy.marketPriceOffer;
  if (cents === 0) return copy.marketFree;
  return formatMoney(cents, lang);
}

/** Validates, stores the photo and publishes. Logging in already proved
 * the address, so there is no confirmation step any more.
 *
 * Owns the uploaded temp file from the moment it is called: every path
 * that rejects discards it. The caller never cleans up. */
async function createListing({ user, title, description, price, file, lang }) {
  const reject = (reason) => {
    storage.discardTemp(file);
    return { ok: false, reason };
  };

  const cleanTitle = oneLine(title, TITLE_MAX);
  if (!cleanTitle || !file) return reject("missing");
  const parsed = parsePrice(price);
  if (!parsed.ok) return reject("price");

  // The photo goes up first, so a row can never point at an object that
  // failed to store. commit() consumes the temp file either way.
  let filename;
  try {
    filename = await storage.commit(file);
  } catch (err) {
    storage.discardTemp(file);
    console.error(`[marketplace] photo upload failed: ${err.message}`);
    return { ok: false, reason: "storage" };
  }

  const { lastInsertRowid: id } = await statements.insertListing.run(
    cleanTitle,
    multiLine(description, DESCRIPTION_MAX),
    parsed.cents,
    filename,
    user.id,
    lang === "en" ? "en" : "sl",
    LISTING_DAYS
  );
  return { ok: true, id };
}

async function markSold(listingId, userId) {
  return Boolean(await statements.markListingSold.get(listingId, userId));
}

async function removeOwn(listingId, userId) {
  return Boolean(await statements.removeListingByOwner.get(listingId, userId));
}

/** Reads a message form: text, an offer, or both - but not neither. */
function readMessage({ body, offer }) {
  const text = multiLine(body, MESSAGE_MAX);
  const offerText = String(offer ?? "").trim();
  let offerCents = null;
  if (offerText) {
    const parsed = parsePrice(offerText);
    if (!parsed.ok || parsed.cents === null) return { ok: false, reason: "offer" };
    offerCents = parsed.cents;
  }
  if (!text && offerCents === null) return { ok: false, reason: "empty" };
  return { ok: true, text, offerCents };
}

/** First message from a buyer about a listing. Opens the conversation, or
 * reuses theirs if they already have one - a buyer has exactly one thread
 * per listing, however many times they press the button. */
async function startConversation({ listingId, buyer, body, offer }) {
  const listing = await statements.listingPublic.get(listingId);
  if (!listing || listing.status !== "active") return { ok: false, reason: "closed" };
  if (listing.user_id === buyer.id) return { ok: false, reason: "own" };
  const message = readMessage({ body, offer });
  if (!message.ok) return message;

  const { id } = await statements.upsertConversation.get(listing.id, buyer.id);
  const conversation = await statements.conversationForUser.get(id, buyer.id);
  return postMessage({ conversation, sender: buyer, body, offer });
}

/** Adds a message to a conversation the sender is already known to be in.
 *
 * Talking carries on after a sale - that is when pickup gets arranged -
 * but not once the listing is deleted or an admin has hidden it. New
 * offers need the listing still for sale. */
async function postMessage({ conversation, sender, body, offer }) {
  if (conversation.listing_status === "removed" || conversation.listing_hidden) return { ok: false, reason: "closed" };
  const message = readMessage({ body, offer });
  if (!message.ok) return message;
  if (message.offerCents !== null && conversation.listing_status !== "active") return { ok: false, reason: "closed" };

  const senderIsBuyer = sender.id === conversation.buyer_id;
  await withTx(async (client) => {
    if (message.offerCents !== null) {
      await client.query(
        "UPDATE messages SET offer_status = 'superseded' WHERE conversation_id = $1 AND offer_status = 'pending'",
        [conversation.id]
      );
    }
    await client.query(
      "INSERT INTO messages (conversation_id, sender_id, body, offer_cents, offer_status) VALUES ($1, $2, $3, $4, $5)",
      [conversation.id, sender.id, message.text, message.offerCents, message.offerCents === null ? null : "pending"]
    );
    // Your own message is read by definition, so writing also moves your
    // read marker - otherwise the reply you just sent would show as unread.
    await client.query(
      `UPDATE conversations SET last_message_at = now(), last_sender_id = $2,
         buyer_read_at  = CASE WHEN $3 THEN now() ELSE buyer_read_at END,
         seller_read_at = CASE WHEN $3 THEN seller_read_at ELSE now() END
       WHERE id = $1`,
      [conversation.id, sender.id, senderIsBuyer]
    );
  });

  notifyRecipient(conversation, sender).catch((err) =>
    console.error(`[marketplace] notify for conversation ${conversation.id} failed: ${err.message}`));
  return { ok: true, conversationId: conversation.id };
}

/** Accept or decline. Only the side that did not make the offer, and only
 * while it is still pending - all enforced in the UPDATE, so a stale page
 * or a crafted request finds nothing to change. */
async function respondToOffer({ conversation, user, messageId, accept }) {
  if (conversation.listing_status !== "active" || conversation.listing_hidden) return { ok: false, reason: "closed" };
  const decided = await withTx(async (client) => {
    const { rows } = await client.query(
      `UPDATE messages SET offer_status = $3
       WHERE id = $1 AND conversation_id = $2 AND offer_status = 'pending' AND sender_id <> $4
       RETURNING id`,
      [messageId, conversation.id, accept ? "accepted" : "declined", user.id]
    );
    if (!rows.length) return false;
    // An answer is news for whoever made the offer, so it moves the thread
    // up their inbox and counts as unread for them, like a message would.
    await client.query(
      `UPDATE conversations SET last_message_at = now(), last_sender_id = $2,
         buyer_read_at  = CASE WHEN buyer_id = $2 THEN now() ELSE buyer_read_at END,
         seller_read_at = CASE WHEN buyer_id = $2 THEN seller_read_at ELSE now() END
       WHERE id = $1`,
      [conversation.id, user.id]
    );
    return true;
  });
  if (!decided) return { ok: false, reason: "stale" };
  notifyRecipient(conversation, user).catch((err) =>
    console.error(`[marketplace] notify for conversation ${conversation.id} failed: ${err.message}`));
  return { ok: true };
}

/** "You have a new message" - once per unread stretch, not per message.
 * The flag flips back when the recipient opens the thread. Never says
 * what the message was: the conversation lives on the site, and an email
 * carrying a stranger's words under our name is a phishing kit. */
async function notifyRecipient(conversation, sender) {
  const transport = getTransporter();
  if (!transport) return;
  const recipientIsBuyer = sender.id !== conversation.buyer_id;
  if (!(await statements.claimNotification.get(conversation.id, recipientIsBuyer))) return;

  const recipient = await statements.userById.get(recipientIsBuyer ? conversation.buyer_id : conversation.seller_id);
  if (!recipient || !recipient.notify) return;

  const lang = recipient.lang === "en" ? "en" : "sl";
  const copy = i18n[lang];
  const link = `${SITE_URL}/messages/${conversation.id}?lang=${lang}`;
  const line = copy.messageEmailBody.replace("{name}", sender.name).replace("{title}", conversation.title);
  await transport.sendMail({
    from: { name: "Sejbosejbo", address: mailFrom() },
    to: recipient.email,
    subject: `${copy.messageEmailSubject}: ${conversation.title}`,
    text: [line, "", link, "", "---", copy.messageEmailSettings, `${SITE_URL}/account?lang=${lang}`].join("\n"),
    html: newMessageEmail({ siteUrl: SITE_URL, copy, line, link, settingsUrl: `${SITE_URL}/account?lang=${lang}` })
  });
}

/** Opening a thread reads it: the badge drops and the next message may
 * email again. */
async function openThread(conversation, userId) {
  const messages = await statements.messagesForConversation.all(conversation.id);
  await statements.markConversationRead.run(conversation.id, userId);
  return messages;
}

/** A participant's report is the only thing that lets an admin read a
 * conversation - see the admin view. */
async function reportConversation({ conversation, reason, details }) {
  const why = REPORT_REASONS.includes(reason) ? reason : "other";
  const note = multiLine(details, 500);
  await statements.reportConversation.run(conversation.id, note ? `${why}: ${note}` : why);
  sendReportNotification({ conversation, reason: why, details: note }).catch(() => {});
}

async function report({ id, reason, details }) {
  const why = REPORT_REASONS.includes(reason) ? reason : "other";
  const listing = await statements.reportListing.get(id);
  if (!listing) return false;
  sendReportNotification({ listing, reason: why, details: multiLine(details, 500) }).catch(() => {});
  return true;
}

/** Deletes every listing whose time is up, photo included; its
 * conversations and messages go with it through the cascade. Serial for
 * the same reason as the post purge. storage.remove() logs a failed delete
 * rather than throwing, so a bucket hiccup can orphan a photo but never
 * keeps someone's messages past their time - a trade made on purpose. */
async function purge(graceDays) {
  let rows;
  try {
    rows = await statements.purgeableListings.all(Math.max(0, graceDays));
  } catch (err) {
    console.error(`[marketplace] could not list purgeable listings: ${err.message}`);
    return;
  }
  for (const row of rows) {
    try {
      if (row.filename) await storage.remove(row.filename);
      await statements.deleteListing.run(row.id);
      console.log(`[marketplace] purged listing ${row.id}`);
    } catch (err) {
      console.error(`[marketplace] purge of listing ${row.id} failed: ${err.message}`);
    }
  }
}

module.exports = {
  LISTING_DAYS,
  REPORT_REASONS,
  isConfigured,
  parsePrice,
  formatPrice,
  formatMoney,
  createListing,
  markSold,
  removeOwn,
  startConversation,
  postMessage,
  respondToOffer,
  openThread,
  reportConversation,
  report,
  purge
};
