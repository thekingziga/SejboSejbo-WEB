const { statements } = require("./db");

// Same graceful-degradation shape as lib/donations.js: missing config means
// "feature off", never a crash. SMTP credentials are infra secrets (env
// vars, like the Stripe/Apple/Google keys), but *who* gets notified is a
// preference an admin should be able to change without a redeploy - that
// one lives in the settings table instead, see getNotifyEmail() below.
let transporter = null;
let attemptedInit = false;

function getTransporter() {
  if (attemptedInit) return transporter;
  attemptedInit = true;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;

  const nodemailer = require("nodemailer");
  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });
  return transporter;
}

async function getNotifyEmail() {
  return (await statements.getSetting.get("notify_email"))?.value || null;
}

async function setNotifyEmail(email) {
  await statements.setSetting.run("notify_email", email || "");
}

/** Fire-and-forget - a report should never fail, or slow down, because
 * email delivery is broken or unconfigured. Errors are logged, not thrown.
 *
 * Takes a post, a marketplace listing or a reported conversation; they
 * only differ in where the links point. */
async function sendReportNotification({ post, listing, conversation, reason, details }) {
  const transport = getTransporter();
  const to = await getNotifyEmail();
  if (!transport || !to) return;

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const target = conversation
    ? {
      label: `conversation #${conversation.id}`,
      url: `https://sejbosejbo.fyi/admin/conversation/${conversation.id}`,
      title: conversation.title,
      review: "https://sejbosejbo.fyi/admin/marketplace"
    }
    : listing
    ? {
      label: `listing #${listing.id}`,
      url: `https://sejbosejbo.fyi/marketplace/${listing.id}`,
      title: listing.title,
      review: "https://sejbosejbo.fyi/admin/marketplace"
    }
    : {
      label: `post #${post.id}`,
      url: `https://sejbosejbo.fyi/post/${post.id}`,
      title: post.title,
      review: "https://sejbosejbo.fyi/admin?filter=reported"
    };

  try {
    await transport.sendMail({
      from,
      to,
      subject: `sejbosejbo.fyi: ${target.label} reported (${reason})`,
      text: [
        `${conversation ? "Conversation" : listing ? "Listing" : "Post"}: ${target.url}`,
        `Title: ${target.title}`,
        `Reason: ${reason}`,
        details ? `Details: ${details}` : null,
        `Review: ${target.review}`
      ].filter(Boolean).join("\n")
    });
  } catch (err) {
    console.error("Report notification email failed:", err.message);
  }
}

/** Held for review: a post, listing or comment the upload scan would not
 * publish. Batched - the first one starts a two-minute window and every
 * item held during it goes out in the same email - because a spam run is
 * exactly when these arrive by the dozen, and one email a minute later
 * says the same as forty. Fire-and-forget like the report emails. */
const HELD_ALERT_DELAY_MS = 2 * 60 * 1000;
const ADMIN_REVIEW = {
  post: "https://sejbosejbo.fyi/admin?filter=held",
  listing: "https://sejbosejbo.fyi/admin/marketplace",
  comment: "https://sejbosejbo.fyi/admin/comments"
};
let heldPending = [];
let heldTimer = null;

function queueHeldAlert({ kind, id, title, reason }) {
  heldPending.push({ kind, id, title, reason });
  if (!heldTimer) {
    heldTimer = setTimeout(() => {
      heldTimer = null;
      sendHeldAlert().catch((err) => console.error(`Held alert email failed: ${err.message}`));
    }, HELD_ALERT_DELAY_MS);
    heldTimer.unref();
  }
}

async function sendHeldAlert() {
  const items = heldPending;
  heldPending = [];
  const transport = getTransporter();
  const to = await getNotifyEmail();
  if (!transport || !to || !items.length) return;

  const kinds = [...new Set(items.map((item) => item.kind))];
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: `sejbosejbo.fyi: ${items.length} ${items.length === 1 ? kinds[0] : "items"} held for review`,
    text: [
      ...items.map((item) => [
        `${item.kind} #${item.id}: ${String(item.title || "").slice(0, 120)}`,
        `  ${item.reason}`
      ].join("\n")),
      "",
      ...kinds.map((kind) => `Review ${kind}s: ${ADMIN_REVIEW[kind]}`)
    ].join("\n")
  });
}

/** Sends a real email to the configured address. Unlike the report
 * notification this one reports failures back to the caller - the whole
 * point is to surface a broken config, so a silent success would be
 * useless. Errors are returned as text rather than thrown. */
async function sendTestEmail() {
  const to = await getNotifyEmail();
  if (!to) {
    return { ok: false, message: "No notify email set. Save one above first." };
  }

  const transport = getTransporter();
  if (!transport) {
    return {
      ok: false,
      message: "SMTP isn't configured - set SMTP_HOST, SMTP_USER and SMTP_PASS in .env, then recreate the container."
    };
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  try {
    await transport.sendMail({
      from,
      to,
      subject: "sejbosejbo.fyi: test email",
      text: [
        "This is a test from the sejbosejbo.fyi admin panel.",
        "",
        "If you're reading this, report notifications will reach you.",
        `Sent: ${new Date().toISOString()}`
      ].join("\n")
    });
    return { ok: true, message: `Sent to ${to}. Check that inbox (and the spam folder).` };
  } catch (err) {
    console.error("Test email failed:", err.message);
    return { ok: false, message: `Send failed: ${String(err.message).slice(0, 300)}` };
  }
}

/** The From address every outgoing mail should use. Falls back to the
 * SMTP username, which is what most relays require the sender to be. */
function mailFrom() {
  return process.env.SMTP_FROM || process.env.SMTP_USER;
}

// getTransporter and mailFrom are exported for lib/subscribers.js, which
// sends its own mail rather than duplicating the SMTP setup.
module.exports = { getNotifyEmail, setNotifyEmail, sendReportNotification, queueHeldAlert, sendTestEmail, getTransporter, mailFrom };
