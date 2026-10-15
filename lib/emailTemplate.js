/**
 * HTML email in the site's own clothes.
 *
 * Plain-text mail from a site that looks like this was jarring - the
 * confirmation gave no signal it came from the same place. These use the
 * same yellow, pink and heavy black borders as the pages.
 *
 * Email rendering is not the web. Constraints this works within:
 *
 * - Everything is inline styles. Gmail strips <style> blocks in some
 *   contexts and most clients ignore external stylesheets entirely.
 * - Layout is tables, not flex or grid, because Outlook renders through
 *   Word's engine and does not support either.
 * - No CSS variables: the dark theme cannot follow here, and a variable
 *   that fails to resolve leaves unreadable text.
 * - Comic Sans is named first but the stack falls back to a system sans,
 *   since a phone almost certainly does not have it.
 * - Every message ships a text/plain alternative too, which is what the
 *   caller passes as `text`.
 */
const COLORS = {
  ink: "#000000",
  paper: "#ffffff",
  hot: "#ffff00",
  pink: "#ff66cc",
  cyan: "#77f7ff",
  muted: "#555555"
};

const FONT = "'Comic Sans MS', 'Comic Sans', 'Chalkboard SE', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A chunky black-bordered button, built as a table because <a> with
 * padding collapses in Outlook. */
function button(href, label, background = COLORS.cyan) {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px auto;">
    <tr>
      <td style="background:${background};border:3px solid ${COLORS.ink};box-shadow:4px 4px 0 ${COLORS.ink};">
        <a href="${escapeHtml(href)}" style="display:block;padding:12px 26px;font:900 17px ${FONT};color:${COLORS.ink};text-decoration:none;">${escapeHtml(label)}</a>
      </td>
    </tr>
  </table>`;
}

/**
 * Wraps body HTML in the site-styled shell.
 *
 * `footerHtml` is where the unsubscribe line goes - deliberately a
 * parameter rather than always-on, because the confirmation email has
 * nothing to unsubscribe from yet.
 */
function wrap({ siteUrl, preheader, heading, bodyHtml, footerHtml = "" }) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.paper};">
  <!-- Preheader: the grey preview line beside the subject in most inboxes.
       Hidden in the message itself, so it is not shown twice. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLORS.paper};">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;border:5px solid ${COLORS.ink};background:${COLORS.paper};">
          <tr>
            <td align="center" style="background:${COLORS.hot};border-bottom:5px solid ${COLORS.ink};padding:18px 16px;">
              <!-- A 180px copy rather than the site's 216KB original: it
                   displays at 90px, and inbox providers penalise heavy
                   mail. Retina-sharp at half its natural size. -->
              <img src="${siteUrl}/public/logo-email.png" width="90" height="90" alt="Sejbosejbo" style="display:block;border:0;margin:0 auto 8px;">
              <div style="font:900 30px ${FONT};color:${COLORS.ink};letter-spacing:1px;">SEJBOSEJBO</div>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 26px 8px;font:400 16px ${FONT};color:${COLORS.ink};">
              <h1 style="margin:0 0 12px;font:900 24px ${FONT};color:${COLORS.ink};">${escapeHtml(heading)}</h1>
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:12px 26px 20px;border-top:3px dashed ${COLORS.ink};font:400 12px ${FONT};color:${COLORS.muted};">
              <a href="${siteUrl}" style="color:${COLORS.muted};">sejbosejbo.fyi</a>
              ${footerHtml}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function confirmationEmail({ siteUrl, copy, link }) {
  return wrap({
    siteUrl,
    preheader: copy.subscribeConfirmBody,
    heading: copy.subscribeConfirmSubject,
    bodyHtml: `
      <p style="margin:0 0 6px;">${escapeHtml(copy.subscribeConfirmBody)}</p>
      ${button(link, copy.subscribeButton, COLORS.cyan)}
      <p style="margin:0 0 10px;font-size:13px;color:${COLORS.muted};">${escapeHtml(copy.subscribeConfirmIgnore)}</p>
      <p style="margin:0 0 4px;font-size:12px;color:${COLORS.muted};word-break:break-all;">
        <a href="${escapeHtml(link)}" style="color:${COLORS.muted};">${escapeHtml(link)}</a>
      </p>`
  });
}

function newPostEmail({ siteUrl, copy, post, postUrl, previewUrl, unsubscribeUrl }) {
  // The same blurred card the link previews use, for the same reason: it
  // shows there is something to look at without giving away the joke.
  const preview = previewUrl
    ? `<a href="${escapeHtml(postUrl)}"><img src="${escapeHtml(previewUrl)}" width="508" alt="${escapeHtml(copy.sharePreviewAlt)}" style="display:block;width:100%;max-width:508px;height:auto;border:3px solid ${COLORS.ink};margin:0 auto 14px;"></a>`
    : "";

  return wrap({
    siteUrl,
    preheader: post.title,
    heading: copy.emailNewPostSubject,
    bodyHtml: `
      <p style="margin:0 0 14px;font:900 19px ${FONT};">${escapeHtml(post.title)}</p>
      ${preview}
      ${button(postUrl, copy.emailOpenPost, COLORS.pink)}`,
    footerHtml: `
      &middot;
      <a href="${escapeHtml(unsubscribeUrl)}" style="color:${COLORS.muted};">${escapeHtml(copy.emailUnsubscribe)}</a>`
  });
}

/** The login link. The button lands on a page with a second button, not
 * straight into a session - see lib/accounts.js for why. */
function loginEmail({ siteUrl, copy, link }) {
  return wrap({
    siteUrl,
    preheader: copy.loginEmailBody,
    heading: copy.loginEmailSubject,
    bodyHtml: `
      <p style="margin:0 0 6px;">${escapeHtml(copy.loginEmailBody)}</p>
      ${button(link, copy.loginEmailButton, COLORS.hot)}
      <p style="margin:0 0 10px;font-size:13px;color:${COLORS.muted};">${escapeHtml(copy.loginEmailIgnore)}</p>
      <p style="margin:0 0 4px;font-size:12px;color:${COLORS.muted};word-break:break-all;">
        <a href="${escapeHtml(link)}" style="color:${COLORS.muted};">${escapeHtml(link)}</a>
      </p>`
  });
}

/** The app's login code. The digits are the whole message, so they are
 * big, spaced and selectable - most people will copy them across. */
function codeEmail({ siteUrl, copy, code, body }) {
  return wrap({
    siteUrl,
    preheader: body,
    heading: copy.codeEmailSubject.replace("{code}", code),
    bodyHtml: `
      <p style="margin:0 0 10px;">${escapeHtml(body)}</p>
      <p style="margin:14px 0;text-align:center;font:900 40px ${FONT};letter-spacing:8px;background:${COLORS.hot};border:3px solid ${COLORS.ink};padding:12px 0;">${escapeHtml(code)}</p>
      <p style="margin:0 0 10px;font-size:13px;color:${COLORS.muted};">${escapeHtml(copy.codeEmailIgnore)}</p>`
  });
}

/** "You have a new message." Deliberately without the message itself:
 * the conversation lives on the site, and mailing a stranger's words out
 * under our name would make this a phishing relay. */
function newMessageEmail({ siteUrl, copy, line, link, settingsUrl }) {
  return wrap({
    siteUrl,
    preheader: line,
    heading: copy.messageEmailSubject,
    bodyHtml: `
      <p style="margin:0 0 6px;">${escapeHtml(line)}</p>
      ${button(link, copy.messageEmailButton, COLORS.pink)}`,
    footerHtml: `
      &middot;
      <a href="${escapeHtml(settingsUrl)}" style="color:${COLORS.muted};">${escapeHtml(copy.messageEmailSettings)}</a>`
  });
}

module.exports = { confirmationEmail, newPostEmail, loginEmail, codeEmail, newMessageEmail };
