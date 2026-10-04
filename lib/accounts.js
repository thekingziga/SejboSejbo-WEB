/**
 * Marketplace accounts: email-link login and a display name.
 *
 * There are no passwords to leak, reset or reuse. You type an address, we
 * mail it a link, and clicking the link is the proof you own it. The rest
 * of the site stays anonymous - an account only exists for buying and
 * selling, where the other person has to be able to find you again.
 *
 * Nothing is created when a link is requested: an address that never
 * clicks never becomes an account, so this form cannot be used to sign
 * someone else up for anything. The link opens a page with a button
 * rather than logging in on the GET, because mail scanners open links to
 * check them, and a scanner spending a one-time link would leave the real
 * person with a "link expired" page.
 */
const crypto = require("crypto");

const { statements } = require("./db");
const i18n = require("./i18n");
const storage = require("./storage");
const { getTransporter, mailFrom } = require("./mail");
const { loginEmail, codeEmail } = require("./emailTemplate");
const { isValidEmail, normalizeEmail } = require("./subscribers");

const SITE_URL = process.env.SITE_URL || "https://sejbosejbo.fyi";

/** Links per address per 15 minutes. Each one is an email we send, so
 * this is what stops the form being pointed at someone's inbox. */
const MAX_RECENT_LINKS = 3;

// Letters in any script (so č, š, ž work), digits, and . _ - between them.
const NAME_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N}._-]{1,22})[\p{L}\p{N}]$/u;
// Names that would read as the site speaking.
const RESERVED_NAMES = new Set(["admin", "administrator", "moderator", "mod", "sejbosejbo", "sejbo", "support", "system"]);

function isConfigured() {
  return Boolean(getTransporter());
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/** Login codes are six digits - a million possibilities - so a plain hash
 * of one is reversed in a blink by anyone holding the database. Keyed with
 * the server secret, the hash is useless without the server as well. The
 * address is mixed in so the same code for two people hashes differently.
 *
 * Falls back to a per-process secret like the session cookie does; codes
 * last 15 minutes, so a restart just means asking for a new one. */
const CODE_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
function hashCode(email, code) {
  return crypto.createHmac("sha256", CODE_SECRET).update(`${email}:${code}`).digest("hex");
}

/** Where to send someone after login. Only a path on this site: an
 * absolute URL here would make the login link an open redirect, a free
 * way to dress a phishing link up as one of ours. */
function safeNext(value) {
  const path = String(value || "");
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.length > 200) return "/marketplace";
  return path;
}

/** Mails a login link. Answers the same way whether or not the address
 * has an account, so the form can't be used to find out who does. */
async function requestLogin({ email, lang, next }) {
  const address = normalizeEmail(email);
  if (!isValidEmail(address)) return { ok: false, reason: "invalid" };

  const transport = getTransporter();
  if (!transport) return { ok: false, reason: "unconfigured" };

  if ((await statements.recentLoginTokens.get(address)).count >= MAX_RECENT_LINKS) {
    return { ok: false, reason: "throttled" };
  }

  const language = lang === "en" ? "en" : "sl";
  const token = crypto.randomBytes(32).toString("base64url");
  await statements.insertLoginToken.run(hashToken(token), address, language, safeNext(next));

  const copy = i18n[language];
  const link = `${SITE_URL}/login/verify?token=${encodeURIComponent(token)}&lang=${language}`;
  try {
    await transport.sendMail({
      from: { name: "Sejbosejbo", address: mailFrom() },
      to: address,
      subject: copy.loginEmailSubject,
      text: [copy.loginEmailBody, "", link, "", copy.loginEmailIgnore].join("\n"),
      html: loginEmail({ siteUrl: SITE_URL, copy, link }),
      replyTo: process.env.MAIL_REPLY_TO || undefined
    });
  } catch (err) {
    console.error(`[accounts] could not send a login link: ${err.message}`);
    return { ok: false, reason: "send" };
  }
  return { ok: true, email: address };
}

/** The app's login: a six-digit code by email. Shares the per-address cap
 * with login links, and answers the same way whether or not the address
 * has an account. A new code retires the previous one. */
async function requestCode({ email, lang }) {
  const address = normalizeEmail(email);
  if (!isValidEmail(address)) return { ok: false, reason: "invalid" };

  const transport = getTransporter();
  if (!transport) return { ok: false, reason: "unconfigured" };

  if ((await statements.recentLoginTokens.get(address)).count >= MAX_RECENT_LINKS) {
    return { ok: false, reason: "throttled" };
  }

  const language = lang === "en" ? "en" : "sl";
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  await statements.retireLoginCodes.run(address);
  await statements.insertLoginCode.run(hashCode(address, code), address, language);

  const copy = i18n[language];
  const body = copy.codeEmailBody.replace("{code}", code);
  try {
    await transport.sendMail({
      from: { name: "Sejbosejbo", address: mailFrom() },
      to: address,
      subject: copy.codeEmailSubject.replace("{code}", code),
      text: [body, "", copy.codeEmailIgnore].join("\n"),
      html: codeEmail({ siteUrl: SITE_URL, copy, code, body }),
      replyTo: process.env.MAIL_REPLY_TO || undefined
    });
  } catch (err) {
    console.error(`[accounts] could not send a login code: ${err.message}`);
    return { ok: false, reason: "send" };
  }
  return { ok: true };
}

/** Checks a code and, if it is right, opens an app session.
 *
 * The attempt is spent before the comparison, in one UPDATE, so the five
 * tries are five however many guesses arrive at once - checking first and
 * counting after would let a burst of parallel guesses all be compared
 * against a live code. The fifth wrong one kills it. */
async function verifyCode({ email, code }) {
  const address = normalizeEmail(email);
  const digits = String(code ?? "").trim();
  if (!isValidEmail(address) || !/^\d{6}$/.test(digits)) return null;

  const attempt = await statements.claimCodeAttempt.get(address);
  if (!attempt) return null;

  const expected = Buffer.from(attempt.token_hash, "hex");
  const given = Buffer.from(hashCode(address, digits), "hex");
  if (!crypto.timingSafeEqual(expected, given)) {
    if (attempt.attempts >= 5) await statements.killLoginCode.run(attempt.token_hash);
    return null;
  }
  const claimed = await statements.consumeLoginCode.get(attempt.token_hash);
  if (!claimed) return null;

  const user = await statements.upsertUserOnLogin.get(claimed.email, claimed.lang);
  const token = crypto.randomBytes(32).toString("base64url");
  await statements.insertAppSession.run(hashToken(token), user.id);
  return { token, userId: user.id };
}

/** The account behind an app token, or null. Bumps the session - and the
 * account's last login, for the one-year purge - at most once a day, so a
 * thread being polled every few seconds is not a write every few seconds. */
async function userForToken(token) {
  if (!token) return null;
  const hash = hashToken(token);
  const user = await statements.appSessionUser.get(hash);
  if (!user) return null;
  if (Date.now() - new Date(user.last_used_at).getTime() > 24 * 60 * 60 * 1000) {
    await statements.touchAppSession.run(hash);
  }
  return user;
}

async function endSession(token) {
  if (token) await statements.deleteAppSession.run(hashToken(token));
}

async function setLang(userId, lang) {
  await statements.setUserLang.run(userId, lang === "en" ? "en" : "sl");
}

async function tokenIsValid(token) {
  if (!token) return false;
  return Boolean(await statements.loginTokenValid.get(hashToken(token)));
}

/** Spends a login link. Returns the account it belongs to - creating it
 * on first use - and where the person was trying to go, or null if the
 * link is unknown, used or expired. */
async function completeLogin(token) {
  if (!token) return null;
  const claimed = await statements.consumeLoginToken.get(hashToken(token));
  if (!claimed) return null;
  const user = await statements.upsertUserOnLogin.get(claimed.email, claimed.lang);
  return { userId: user.id, hasName: Boolean(user.name), next: safeNext(claimed.next_path), lang: claimed.lang };
}

async function setName(userId, rawName) {
  const name = String(rawName ?? "").normalize("NFC").trim();
  if (!NAME_RE.test(name)) return { ok: false, reason: "invalid" };
  if (RESERVED_NAMES.has(name.toLowerCase())) return { ok: false, reason: "taken" };
  try {
    await statements.setUserName.run(userId, name);
  } catch (err) {
    // The unique index on lower(name) is the real check - a SELECT first
    // would race two people picking the same name at once.
    if (err.code === "23505") return { ok: false, reason: "taken" };
    throw err;
  }
  return { ok: true, name };
}

async function setNotify(userId, on) {
  await statements.setUserNotify.run(userId, Boolean(on));
}

/** Deletes an account and everything hanging off it: listings, their
 * photos, conversations, messages. The photos have to go first and by
 * hand - the rows cascade, but nothing in the database can delete an
 * object from the bucket. */
async function deleteAccount(userId) {
  const files = await statements.userListingFiles.all(userId);
  for (const { filename } of files) await storage.remove(filename);
  return Boolean(await statements.deleteUser.get(userId));
}

/** Expired login links and codes, app sessions unused for 90 days, and
 * accounts nobody has logged into for a year.
 * An account is an email address plus messages; holding those for
 * someone who has stopped coming is a liability, not a service. */
async function purge() {
  try {
    await statements.purgeLoginTokens.run();
    await statements.purgeAppSessions.run();
    for (const { id } of await statements.inactiveUsers.all()) {
      await deleteAccount(id);
      console.log(`[accounts] deleted account ${id} after a year without a login`);
    }
  } catch (err) {
    console.error(`[accounts] purge failed: ${err.message}`);
  }
}

module.exports = {
  isConfigured,
  safeNext,
  requestLogin,
  requestCode,
  verifyCode,
  userForToken,
  endSession,
  setLang,
  tokenIsValid,
  completeLogin,
  setName,
  setNotify,
  deleteAccount,
  purge
};
