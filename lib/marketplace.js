/**
 * The marketplace: classified ads with an email relay.
 *
 * No money moves through the site and there are no accounts. A seller
 * gives an email address that is never shown; it gets one message with a
 * link that publishes the listing and, on every later visit, manages it.
 * Buyers write through a form and the site forwards the message, with the
 * buyer's address as Reply-To, so the two can carry on directly without
 * either address having been published.
 *
 * The confirm step does three jobs at once. It proves the address belongs
 * to whoever is posting, it stops this form from being a way to make the
 * site send mail to a stranger more than once, and it means nothing goes
 * public until a human has clicked something in a real inbox.
 *
 * Same graceful degradation as subscribers: with SMTP unconfigured there is
 * no way to confirm or relay anything, so the whole feature reports itself
 * unavailable instead of accepting listings it can never publish.
 */
const crypto = require("crypto");

const { statements } = require("./db");
const i18n = require("./i18n");
const storage = require("./storage");
const { getTransporter, mailFrom, sendReportNotification } = require("./mail");
const { listingConfirmEmail, listingMessageEmail } = require("./emailTemplate");
const { isValidEmail, normalizeEmail } = require("./subscribers");

const SITE_URL = process.env.SITE_URL || "https://sejbosejbo.fyi";

/** How long a listing stays up once published. */
const LISTING_DAYS = 30;

/** Unconfirmed listings one address may have waiting at once. Each one is
 * an email we send to that address, so without a cap the form could be
 * pointed at someone's inbox and fired repeatedly. */
const MAX_PENDING_PER_EMAIL = 3;

const TITLE_MAX = 120;
const DESCRIPTION_MAX = 2000;
const MESSAGE_MAX = 2000;
// Seven figures of euros. Anything above is a joke listing, and the site
// can carry the joke in the description instead of in an integer overflow.
const PRICE_MAX_CENTS = 999_999_999;

const REPORT_REASONS = ["scam", "prohibited", "spam", "other"];

function isConfigured() {
  return Boolean(getTransporter());
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
  const text = String(raw ?? "").trim().replace(/\s/g, "");
  if (!text) return { ok: true, cents: null };
  const match = /^(\d{1,7})(?:[.,](\d{1,2}))?$/.exec(text);
  if (!match) return { ok: false };
  const cents = Number(match[1]) * 100 + Number((match[2] || "0").padEnd(2, "0"));
  if (cents > PRICE_MAX_CENTS) return { ok: false };
  return { ok: true, cents };
}

function formatPrice(cents, lang) {
  const copy = i18n[lang === "sl" ? "sl" : "en"];
  if (cents === null || cents === undefined) return copy.marketPriceOffer;
  if (cents === 0) return copy.marketFree;
  return new Intl.NumberFormat(lang === "sl" ? "sl-SI" : "en-IE", { style: "currency", currency: "EUR" }).format(cents / 100);
}

function manageUrl(token, lang) {
  return `${SITE_URL}/marketplace/manage/${encodeURIComponent(token)}?lang=${lang}`;
}

function listingUrl(id, lang) {
  return `${SITE_URL}/marketplace/${id}?lang=${lang}`;
}

/** Validates, stores the photo, writes a pending row and mails the link.
 *
 * Owns the uploaded temp file from the moment it is called: every path
 * that rejects discards it, and a failure after the photo reached the
 * bucket deletes it from there too. The caller never cleans up. */
async function createListing({ title, description, price, file, email, lang }) {
  const language = lang === "en" ? "en" : "sl";
  const reject = (reason) => {
    storage.discardTemp(file);
    return { ok: false, reason };
  };

  const cleanTitle = oneLine(title, TITLE_MAX);
  const address = normalizeEmail(email);
  if (!cleanTitle || !file) return reject("missing");
  if (!isValidEmail(address)) return reject("email");
  const parsed = parsePrice(price);
  if (!parsed.ok) return reject("price");

  const transport = getTransporter();
  if (!transport) return reject("unconfigured");

  if ((await statements.pendingListingsForEmail.get(address)).count >= MAX_PENDING_PER_EMAIL) {
    return reject("pending");
  }

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

  const token = crypto.randomBytes(24).toString("base64url");
  const { lastInsertRowid: id } = await statements.insertListing.run(
    cleanTitle,
    multiLine(description, DESCRIPTION_MAX),
    parsed.cents,
    filename,
    address,
    language,
    token
  );

  const copy = i18n[language];
  const link = manageUrl(token, language);
  try {
    await transport.sendMail({
      from: { name: "Sejbosejbo", address: mailFrom() },
      to: address,
      subject: copy.marketConfirmSubject,
      text: [copy.marketConfirmBody.replace("{title}", cleanTitle), "", link, "", copy.marketConfirmIgnore].join("\n"),
      html: listingConfirmEmail({ siteUrl: SITE_URL, copy, title: cleanTitle, link }),
      replyTo: process.env.MAIL_REPLY_TO || undefined
    });
  } catch (err) {
    // A listing whose seller never got the link can never be published,
    // so keeping it would only hold their address for 48 hours for
    // nothing. Undo the whole thing and let them try again.
    console.error(`[marketplace] could not send confirmation for listing ${id}: ${err.message}`);
    await statements.deleteListing.run(id);
    await storage.remove(filename);
    return { ok: false, reason: "send" };
  }

  return { ok: true, email: address };
}

/** The seller's page. Visiting it is also how a pending listing gets
 * published - the link in the email is a plain GET so it works from any
 * mail client. A link scanner prefetching it would publish the listing
 * too, which is acceptable: it only ever sees the link because the mail
 * reached that inbox, which is exactly what the click is meant to prove. */
async function openManage(token) {
  if (!token) return null;
  const activated = await statements.activateListing.get(token, LISTING_DAYS);
  const listing = await statements.listingByToken.get(token);
  return listing ? { listing, justActivated: Boolean(activated) } : null;
}

async function markSold(token) {
  return Boolean(await statements.markListingSold.get(token));
}

async function removeByToken(token) {
  return Boolean(await statements.removeListingByToken.get(token));
}

/** Forwards a buyer's message to the seller. Nothing is stored: the
 * message and the buyer's address exist only in the email that goes out. */
async function contactSeller({ id, message, buyerEmail }) {
  const text = multiLine(message, MESSAGE_MAX);
  const replyTo = normalizeEmail(buyerEmail);
  if (!text || !isValidEmail(replyTo)) return { ok: false, reason: "invalid" };

  const transport = getTransporter();
  if (!transport) return { ok: false, reason: "unconfigured" };

  const listing = await statements.listingForContact.get(id);
  if (!listing) return { ok: false, reason: "closed" };

  const copy = i18n[listing.lang === "en" ? "en" : "sl"];
  const listingLink = listingUrl(listing.id, listing.lang);
  const manageLink = manageUrl(listing.token, listing.lang);
  try {
    await transport.sendMail({
      from: { name: "Sejbosejbo", address: mailFrom() },
      to: listing.seller_email,
      replyTo,
      subject: `${copy.marketMsgSubject}: ${listing.title}`,
      text: [
        copy.marketMsgIntro.replace("{title}", listing.title),
        "",
        text,
        "",
        copy.marketMsgReply.replace("{email}", replyTo),
        "",
        listingLink,
        "",
        "---",
        `${copy.marketMsgManage}: ${manageLink}`
      ].join("\n"),
      html: listingMessageEmail({
        siteUrl: SITE_URL,
        copy,
        title: listing.title,
        message: text,
        buyerEmail: replyTo,
        listingUrl: listingLink,
        manageUrl: manageLink
      })
    });
  } catch (err) {
    console.error(`[marketplace] could not relay a message for listing ${listing.id}: ${err.message}`);
    return { ok: false, reason: "send" };
  }
  return { ok: true };
}

async function report({ id, reason, details }) {
  const why = REPORT_REASONS.includes(reason) ? reason : "other";
  const listing = await statements.reportListing.get(id);
  if (!listing) return false;
  sendReportNotification({ listing, reason: why, details: multiLine(details, 500) }).catch(() => {});
  return true;
}

/** Deletes every listing whose time is up, photo and seller address
 * included. Serial for the same reason as the post purge: a home server
 * sharing a remote bucket gains nothing from a burst of parallel deletes.
 * storage.remove() logs a failed delete rather than throwing, so a bucket
 * hiccup can orphan a photo but never keeps a seller's address past its
 * time - that is the trade this makes on purpose. */
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
  createListing,
  openManage,
  markSold,
  removeByToken,
  contactSeller,
  report,
  purge
};
