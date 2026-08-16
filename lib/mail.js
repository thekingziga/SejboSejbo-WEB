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
 * email delivery is broken or unconfigured. Errors are logged, not thrown. */
async function sendReportNotification({ post, reason, details }) {
  const transport = getTransporter();
  const to = await getNotifyEmail();
  if (!transport || !to) return;

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const postUrl = `https://sejbosejbo.fyi/post/${post.id}`;

  try {
    await transport.sendMail({
      from,
      to,
      subject: `sejbosejbo.fyi: post #${post.id} reported (${reason})`,
      text: [
        `Post: ${postUrl}`,
        `Title: ${post.title}`,
        `Reason: ${reason}`,
        details ? `Details: ${details}` : null,
        `Review: https://sejbosejbo.fyi/admin?filter=reported`
      ].filter(Boolean).join("\n")
    });
  } catch (err) {
    console.error("Report notification email failed:", err.message);
  }
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

module.exports = { getNotifyEmail, setNotifyEmail, sendReportNotification, sendTestEmail };
