/**
 * Response security headers.
 *
 * The site shipped with none of these: no CSP, no clickjacking defence,
 * no MIME-sniffing defence, and an X-Powered-By header announcing the
 * stack for free. None of that was exploitable on its own, but every one
 * of them turns a small bug into a bigger one.
 */
const crypto = require("crypto");

/** Any origin images and media are actually served from, so the CSP
 * doesn't blank the site the moment S3_PUBLIC_BASE_URL is set. Reading it
 * lazily rather than at require time keeps it honest if the env changes
 * between tests. */
function mediaOrigins() {
  const base = process.env.S3_PUBLIC_BASE_URL;
  if (!base) return [];
  try {
    return [new URL(base).origin];
  } catch {
    return [];
  }
}

function buildCsp(nonce) {
  const media = mediaOrigins();
  return [
    "default-src 'self'",
    // Strict: a nonce, and no 'unsafe-inline'. Adding a nonce makes
    // browsers ignore 'unsafe-inline' even if some later edit adds it
    // back, so injected <script> tags stay dead.
    `script-src 'self' 'nonce-${nonce}'`,
    // 'unsafe-inline' only for styles, and only because the Sejbometer
    // sets its fill width as a style attribute - nonces do not apply to
    // style attributes, so the alternative is a stylesheet rule per
    // percentage. Injected CSS is a far smaller problem than injected JS.
    "style-src 'self' 'unsafe-inline'",
    ["img-src 'self' data:", ...media].join(" "),
    ["media-src 'self'", ...media].join(" "),
    "font-src 'self'",
    "connect-src 'self'",
    // Nothing here embeds anything, so the safest possible answers.
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'self'",
    // Stops a form on an injected page from posting credentials offsite.
    // Stripe checkout is a top-level redirect, not a form post, so this
    // does not affect donations.
    "form-action 'self'",
    // The modern X-Frame-Options: DENY, and it beats it on coverage.
    "frame-ancestors 'none'"
  ].join("; ");
}

function securityHeaders() {
  return function securityHeadersMiddleware(req, res, next) {
    // Used by the inline bootstrap script in the page layout.
    res.locals.cspNonce = crypto.randomBytes(16).toString("base64");

    res.setHeader("Content-Security-Policy", buildCsp(res.locals.cspNonce));
    // Kept alongside frame-ancestors for browsers that predate CSP3.
    res.setHeader("X-Frame-Options", "DENY");
    // Stops a browser from deciding an uploaded .png is really HTML and
    // running it - the classic route from "user can upload files" to
    // "user can run scripts on your domain".
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");

    // Only over a real HTTPS connection. Sending HSTS over plain HTTP is
    // ignored by browsers anyway, and setting it during local development
    // would pin localhost to HTTPS in the developer's browser for a year.
    if (req.secure || req.headers["x-forwarded-proto"] === "https") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }

    next();
  };
}

module.exports = { securityHeaders, buildCsp };
