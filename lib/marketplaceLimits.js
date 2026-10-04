/**
 * Rate limits for the marketplace, shared by the website and the app API.
 *
 * One limiter per action, not one per surface: an account that could post
 * five listings an hour on the web and five more from the app would simply
 * have a limit of ten. Logged-in actions are keyed by account - the web's
 * cookie and the app's token both end up as req.user - so a whole office
 * behind one address doesn't share a quota, and one person doesn't get a
 * fresh one by switching networks.
 *
 * The 429 itself has to fit whoever asked: JSON with a machine code for
 * the API, a page for the website. The page needs the site's layout, which
 * lives in server.js, so it registers a renderer here at startup.
 */
const i18n = require("./i18n");
const { createRateLimiter } = require("./rateLimit");
const { getClientIp } = require("./ip");

let renderPage = null;
function setPageRenderer(fn) {
  renderPage = fn;
}

const byAccount = (req) => (req.user ? `u:${req.user.id}` : `ip:${getClientIp(req)}`);
const byIp = (req) => `ip:${getClientIp(req)}`;

function limiter({ windowMs, max, keyFn = byAccount }) {
  return createRateLimiter({
    windowMs,
    max,
    keyFn,
    onLimit: async (req, res, retryAfter) => {
      const minutes = Math.ceil(retryAfter / 60);
      if (req.originalUrl.startsWith("/api/") || !renderPage) {
        const copy = i18n[req.query?.lang === "sl" ? "sl" : "en"];
        return res.status(429).json({
          error: copy.marketThrottled.replace("{minutes}", String(minutes)),
          code: "rate_limited",
          retry_after_seconds: retryAfter
        });
      }
      return renderPage(req, res, minutes);
    }
  });
}

const HOUR = 60 * 60 * 1000;

module.exports = {
  setPageRenderer,
  // Each of these sends someone an email, so they are capped per IP
  // before anything else; lib/accounts.js caps them per address as well.
  loginRequestLimit: limiter({ windowMs: HOUR, max: 5, keyFn: byIp }),
  // Each guess also spends one of a code's five attempts; this caps how
  // many codes one address can be made to burn through.
  codeVerifyLimit: limiter({ windowMs: 15 * 60 * 1000, max: 20, keyFn: byIp }),
  listingCreateLimit: limiter({ windowMs: HOUR, max: 5 }),
  // Generous: a conversation is a lot of short messages, and polling an
  // open thread is a GET, which this does not count.
  messageLimit: limiter({ windowMs: HOUR, max: 40 }),
  listingReportLimit: limiter({ windowMs: HOUR, max: 10 })
};
