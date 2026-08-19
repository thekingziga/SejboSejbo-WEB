/**
 * Email notifications for new posts, double opt-in.
 *
 * Anyone can type someone else's address into a form, so an address that
 * has only been submitted is not a subscriber - it is a claim. Nothing is
 * ever sent to it except the one confirmation message. Only after the
 * link is clicked does confirmed_at get set and the address start
 * receiving posts.
 *
 * That is also what the GDPR requires of a mailing list run from the EU:
 * demonstrable consent, and a working unsubscribe in every message. The
 * unsubscribe link is a token in the row, so it works without logging in
 * and without any confirmation step.
 *
 * With SMTP unconfigured the whole feature reports itself as unavailable
 * rather than silently accepting addresses it can never mail.
 */
const crypto = require("crypto");

const { statements } = require("./db");
const i18n = require("./i18n");
const { getTransporter, mailFrom } = require("./mail");
const { confirmationEmail, newPostEmail } = require("./emailTemplate");

const SITE_URL = process.env.SITE_URL || "https://sejbosejbo.fyi";

// Deliberately permissive. Strict email regexes reject valid addresses,
// and the confirmation step is the real check: an address that cannot
// receive mail never becomes a subscriber.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isConfigured() {
  return Boolean(getTransporter());
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmail(value) {
  return EMAIL_RE.test(value) && value.length <= 254;
}

function newToken() {
  return crypto.randomBytes(24).toString("base64url");
}

/** Registers an address and sends it a confirmation link.
 *
 * Returns the same shape whether the address is new, already pending, or
 * already confirmed. The caller shows one message for all three: telling
 * a stranger which addresses are already on the list is an information
 * leak, and a small one, but free to avoid. */
async function requestSubscription({ email, lang }) {
  const address = normalizeEmail(email);
  if (!isValidEmail(address)) return { ok: false, reason: "invalid" };

  const transport = getTransporter();
  if (!transport) return { ok: false, reason: "unconfigured" };

  const language = lang === "en" ? "en" : "sl";
  const confirmToken = newToken();
  const row = await statements.upsertSubscriber.get(
    address,
    language,
    confirmToken,
    newToken()
  );

  // Already confirmed: do not send anything. Re-sending a confirmation
  // to a confirmed address is a way to use this form to mail someone
  // repeatedly.
  if (row?.confirmed_at) return { ok: true, alreadyConfirmed: true };

  const copy = i18n[language];
  const link = `${SITE_URL}/subscribe/confirm?token=${encodeURIComponent(confirmToken)}`;
  try {
    await transport.sendMail({
      from: { name: "Sejbosejbo", address: mailFrom() },
      to: address,
      subject: copy.subscribeConfirmSubject,
      // Both parts, always: some clients and most spam filters want a
      // text alternative, and a message with only HTML scores worse.
      text: [copy.subscribeConfirmBody, "", link, "", copy.subscribeConfirmIgnore].join("\n"),
      html: confirmationEmail({ siteUrl: SITE_URL, copy, link })
    });
  } catch (err) {
    console.error(`[subscribers] could not send confirmation to ${address}: ${err.message}`);
    return { ok: false, reason: "send_failed" };
  }
  return { ok: true };
}

/** Confirms a pending address. Idempotent from the visitor's point of
 * view: a second click on the same link finds the row already confirmed
 * and still reports success, rather than looking broken. */
async function confirmSubscription(token) {
  if (!token) return { ok: false };
  const confirmed = await statements.confirmSubscriber.get(token);
  if (confirmed) return { ok: true, email: confirmed.email };

  const existing = await statements.subscriberByConfirmToken.get(token);
  if (existing?.confirmed_at) return { ok: true, email: existing.email, already: true };
  return { ok: false };
}

async function unsubscribe(token) {
  if (!token) return { ok: false };
  const removed = await statements.deleteSubscriberByToken.get(token);
  return removed ? { ok: true, email: removed.email } : { ok: false };
}

async function counts() {
  return await statements.countSubscribers.get();
}

/** Mails every confirmed subscriber about a new post.
 *
 * Never throws - an upload must not fail because the mail server is
 * down. Sent one at a time rather than in parallel: this is a home SMTP
 * relay, and hammering it is a good way to look like a spam source.
 */
async function announcePost(post) {
  try {
    const transport = getTransporter();
    if (!transport) return { sent: 0, skipped: "not configured" };

    const recipients = await statements.confirmedSubscribers.all();
    if (recipients.length === 0) return { sent: 0 };

    const postUrl = `${SITE_URL}/post/${post.id}`;
    let sent = 0;
    for (const recipient of recipients) {
      const copy = i18n[recipient.lang === "en" ? "en" : "sl"];
      const unsubscribeUrl = `${SITE_URL}/unsubscribe?token=${encodeURIComponent(recipient.unsubscribe_token)}`;
      try {
        await transport.sendMail({
          from: { name: "Sejbosejbo", address: mailFrom() },
          to: recipient.email,
          subject: `${copy.emailNewPostSubject}: ${post.title}`,
          text: [post.title, "", postUrl, "", "---", `${copy.emailUnsubscribe}: ${unsubscribeUrl}`].join("\n"),
          html: newPostEmail({
            siteUrl: SITE_URL,
            copy,
            post,
            postUrl,
            // Text-only posts have nothing to blur, so they simply get no
            // image rather than a broken one.
            previewUrl: post.filename ? `${SITE_URL}/post/${post.id}/preview.jpg` : null,
            unsubscribeUrl
          }),
          // Lets a mail client offer one-click unsubscribe, and keeps
          // this out of spam folders that penalise bulk mail without it.
          // Deliverability headers. A new sending domain has no reputation
          // with Gmail, and bulk mail that does not identify itself as a
          // list is treated with more suspicion, not less.
          headers: {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            // Identifies this as a genuine opt-in list rather than an
            // unsolicited blast from an unknown domain.
            "List-Id": `sejbosejbo.fyi posts <posts.${new URL(SITE_URL).hostname}>`
          },
          // A no-reply From with nowhere to reply scores worse, and it
          // also means a real person replying is not silently lost.
          replyTo: process.env.MAIL_REPLY_TO || undefined
        });
        sent++;
      } catch (err) {
        console.error(`[subscribers] could not mail ${recipient.email}: ${err.message}`);
      }
    }
    console.log(`[subscribers] post #${post.id}: mailed ${sent}/${recipients.length}`);
    return { sent };
  } catch (err) {
    console.error(`[subscribers] could not announce post #${post.id}: ${err.message}`);
    return { sent: 0, error: err.message };
  }
}

module.exports = {
  isConfigured,
  isValidEmail,
  normalizeEmail,
  requestSubscription,
  confirmSubscription,
  unsubscribe,
  counts,
  announcePost
};
