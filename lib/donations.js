const jwt = require("jsonwebtoken");

const { statements } = require("./db");

// Server-side source of truth for what each tier costs. Never take the
// amount from the client - the fraudulent move is a small charge with a
// tier_id claiming the big one.
const TIERS = {
  small: { amount_minor: 200, currency: "eur", label: "small" },
  medium: { amount_minor: 500, currency: "eur", label: "medium" },
  large: { amount_minor: 1500, currency: "eur", label: "large" }
};

const APPLE_PRODUCT_TIERS = {
  "fyi.sejbosejbo.tip.small": "small",
  "fyi.sejbosejbo.tip.medium": "medium",
  "fyi.sejbosejbo.tip.large": "large"
};

class NotConfiguredError extends Error {
  constructor(message) {
    super(message);
    this.status = 503;
  }
}

class InvalidRequestError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/** Stripe/Apple/Google SDK errors can carry sensitive detail (a bad-key
 * error literally echoes the key back). Log the real error server-side and
 * surface only a generic message to the client - anything that isn't
 * already one of our own typed errors gets rewritten here. */
async function guardProviderCall(fn, fallbackMessage) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NotConfiguredError || err instanceof InvalidRequestError) throw err;
    console.error(err);
    const wrapped = new Error(fallbackMessage);
    wrapped.status = 502;
    throw wrapped;
  }
}

let stripeClient = null;
function getStripe() {
  if (stripeClient) return stripeClient;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new NotConfiguredError("Stripe donations are not configured yet.");
  const Stripe = require("stripe");
  stripeClient = new Stripe(key);
  return stripeClient;
}

async function createStripeCheckoutSession(tierId, origin) {
  const tier = TIERS[tierId];
  if (!tier) throw new InvalidRequestError("Unknown tier_id.");

  const stripe = getStripe();
  const session = await guardProviderCall(
    () =>
      stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: tier.currency,
              unit_amount: tier.amount_minor,
              product_data: { name: `sejbosejbo.fyi tip (${tier.label})` }
            },
            quantity: 1
          }
        ],
        success_url: `${origin}/donate/thanks`,
        cancel_url: `${origin}/donate/cancelled`,
        metadata: { tier_id: tierId }
      }),
    "Could not start a Stripe checkout session right now."
  );

  return session.url;
}

function verifyStripeWebhookEvent(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new NotConfiguredError("Stripe webhook is not configured yet.");
  const stripe = getStripe();
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

function recordDonation({ source, tierId, amountMinor, currency, externalId }) {
  const result = statements.insertDonation.run(
    source,
    tierId || null,
    amountMinor ?? null,
    currency || "EUR",
    externalId
  );
  // changes === 0 means external_id already existed (INSERT OR IGNORE) -
  // a webhook/receipt replay, already recorded, and not an error.
  return result.changes > 0;
}

function handleStripeCheckoutCompleted(session) {
  const tierId = session.metadata?.tier_id || null;
  recordDonation({
    source: "stripe",
    tierId,
    amountMinor: session.amount_total,
    currency: (session.currency || "eur").toUpperCase(),
    externalId: session.id
  });
}

/** Apple App Store Server API needs a JWT signed with an ES256 private key
 * tied to an in-app-purchase API key generated in App Store Connect - none
 * of that exists until the Apple Developer account is set up. The
 * transaction-fetch call itself is written for real use; it just can't be
 * exercised without those three env vars. */
function getApplePrivateKey() {
  const key = process.env.APPLE_IAP_PRIVATE_KEY;
  const keyId = process.env.APPLE_IAP_KEY_ID;
  const issuerId = process.env.APPLE_IAP_ISSUER_ID;
  const bundleId = process.env.APPLE_BUNDLE_ID || "fyi.sejbosejbo";
  if (!key || !keyId || !issuerId) {
    throw new NotConfiguredError("Apple in-app purchase verification is not configured yet.");
  }
  return { key: key.replace(/\\n/g, "\n"), keyId, issuerId, bundleId };
}

function signAppleJwt() {
  const { key, keyId, issuerId, bundleId } = getApplePrivateKey();
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: issuerId,
      iat: now,
      exp: now + 300,
      aud: "appstoreconnect-v1",
      bid: bundleId
    },
    key,
    { algorithm: "ES256", keyid: keyId }
  );
}

const APPLE_API_BASE = process.env.APPLE_IAP_SANDBOX === "true"
  ? "https://api.storekit-sandbox.itunes.apple.com"
  : "https://api.storekit.itunes.apple.com";

async function verifyAppleReceipt({ productId, token }) {
  if (!productId || !token) throw new InvalidRequestError("product_id and token are required.");
  const tierId = APPLE_PRODUCT_TIERS[productId];
  if (!tierId) throw new InvalidRequestError("Unknown product_id.");

  const signedJwt = signAppleJwt();
  const response = await guardProviderCall(
    () =>
      fetch(`${APPLE_API_BASE}/inApps/v1/transactions/${encodeURIComponent(token)}`, {
        headers: { Authorization: `Bearer ${signedJwt}` }
      }),
    "Could not reach Apple to verify this purchase."
  );

  if (!response.ok) {
    throw new InvalidRequestError("Apple could not verify this transaction.");
  }

  const body = await response.json();
  // signedTransactionInfo is itself a signed JWT; the payload segment is
  // enough here since App Store Server API responses are only reachable
  // over TLS with our own bearer token, but a production build should
  // verify its signature too rather than trust the payload blindly.
  const payloadSegment = body.signedTransactionInfo?.split(".")[1];
  if (!payloadSegment) throw new InvalidRequestError("Malformed Apple response.");
  const transaction = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));

  if (transaction.productId !== productId) {
    throw new InvalidRequestError("Transaction does not match the declared product_id.");
  }

  const tier = TIERS[tierId];
  recordDonation({
    source: "apple",
    tierId,
    amountMinor: tier.amount_minor,
    currency: tier.currency.toUpperCase(),
    externalId: `apple:${transaction.transactionId}`
  });
}

/** Google Play verification needs a service account with access to the
 * Play Developer API for this app's package - also not provisioned yet.
 * Written for real use once GOOGLE_SERVICE_ACCOUNT_JSON and
 * GOOGLE_PACKAGE_NAME are set. */
async function verifyGoogleReceipt({ productId, token }) {
  if (!productId || !token) throw new InvalidRequestError("product_id and token are required.");
  const tierId = APPLE_PRODUCT_TIERS[productId]; // same fyi.sejbosejbo.tip.* ids on both stores
  if (!tierId) throw new InvalidRequestError("Unknown product_id.");

  const credsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const packageName = process.env.GOOGLE_PACKAGE_NAME;
  if (!credsJson || !packageName) {
    throw new NotConfiguredError("Google Play verification is not configured yet.");
  }

  const { GoogleAuth } = require("google-auth-library");
  const auth = new GoogleAuth({
    credentials: JSON.parse(credsJson),
    scopes: ["https://www.googleapis.com/auth/androidpublisher"]
  });
  const client = await auth.getClient();
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}`;
  const response = await guardProviderCall(
    () => client.request({ url }),
    "Could not reach Google Play to verify this purchase."
  );

  // purchaseState: 0 = purchased, 1 = cancelled, 2 = pending
  if (response.data?.purchaseState !== 0) {
    throw new InvalidRequestError("This purchase was not completed.");
  }

  const tier = TIERS[tierId];
  recordDonation({
    source: "google",
    tierId,
    amountMinor: tier.amount_minor,
    currency: tier.currency.toUpperCase(),
    externalId: `google:${response.data.orderId || token}`
  });
}

/** Mounted directly on the app (not the /api/v1 router) ahead of
 * express.json(), since Stripe's signature check needs the exact raw
 * request bytes - see server.js for the express.raw() wiring. */
function stripeWebhookHandler(req, res) {
  const signature = req.headers["stripe-signature"];
  let event;
  try {
    event = verifyStripeWebhookEvent(req.body, signature);
  } catch (err) {
    // A bad/missing signature is the caller's fault (400); a missing
    // STRIPE_WEBHOOK_SECRET is our own NotConfiguredError (503). Stripe's
    // signature-mismatch message is safe to return as-is - it never
    // contains the secret, just says it didn't match.
    const status = err.status || 400;
    if (status >= 500) console.error(err);
    return res.status(status).json({ error: err.message || "Invalid webhook." });
  }

  if (event.type === "checkout.session.completed") {
    handleStripeCheckoutCompleted(event.data.object);
  }

  res.json({ received: true });
}

module.exports = {
  TIERS,
  NotConfiguredError,
  InvalidRequestError,
  createStripeCheckoutSession,
  verifyStripeWebhookEvent,
  handleStripeCheckoutCompleted,
  stripeWebhookHandler,
  verifyAppleReceipt,
  verifyGoogleReceipt
};
