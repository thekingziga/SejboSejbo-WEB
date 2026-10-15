/**
 * Push notifications via Firebase Cloud Messaging (HTTP v1).
 *
 * The site posts two or three times a day and nothing pulls anyone back
 * to it - no notification, no email, no feed. This is the half that runs
 * on the server: it stores the tokens the app registers, and sends one
 * message per new post.
 *
 * Same graceful-degradation rule as the rest of the app: with
 * FCM_SERVICE_ACCOUNT_JSON unset this is simply off. Registration still
 * succeeds and tokens still accumulate, so the app can ship before the
 * credentials exist and every install already registered gets the first
 * notification once they do.
 *
 * Uses google-auth-library, which is already a dependency for Play
 * receipt verification, rather than pulling in firebase-admin - that
 * package is large and its extra surface (Firestore, auth, storage) is
 * not wanted here.
 */
const { statements } = require("./db");
const i18n = require("./i18n");

const SEND_TIMEOUT_MS = Number(process.env.FCM_TIMEOUT_MS || 10000);
// FCM has no bulk endpoint in the v1 API, so this is one request per
// token. Sent in batches so a few hundred devices don't open a few
// hundred sockets at once on a Raspberry Pi.
const BATCH_SIZE = Number(process.env.FCM_BATCH_SIZE || 20);

let authClient = null;
let projectId = null;

function credentials() {
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[push] FCM_SERVICE_ACCOUNT_JSON is not valid JSON: ${err.message}`);
    return null;
  }
}

function isConfigured() {
  return Boolean(credentials());
}

async function getClient() {
  if (authClient) return authClient;
  const creds = credentials();
  if (!creds) return null;

  const { GoogleAuth } = require("google-auth-library");
  const auth = new GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/firebase.messaging"]
  });
  authClient = await auth.getClient();
  projectId = creds.project_id;
  return authClient;
}

/** Registration is deliberately independent of whether sending works.
 * Tokens collected before the credentials exist are not wasted. */
async function registerDevice({ token, platform, lang }) {
  await statements.upsertPushDevice.run(
    token,
    platform === "ios" ? "ios" : "android",
    lang === "en" ? "en" : "sl"
  );
}

async function unregisterDevice(token) {
  await statements.deletePushDevice.run(token);
}

async function deviceCount() {
  return (await statements.countPushDevices.get()).count;
}

/** FCM answers per token. A token that FCM says is gone is deleted here,
 * otherwise the table fills with dead installs that are retried forever. */
function isDeadTokenResponse(status, body) {
  if (status === 404) return true;
  const code = body?.error?.details?.find?.((d) => d.errorCode)?.errorCode;
  return code === "UNREGISTERED" || code === "INVALID_ARGUMENT";
}

async function sendToToken(client, token, message) {
  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  const headers = await client.getRequestHeaders(url);
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { token, ...message } }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
  });

  if (response.ok) return { ok: true };
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* non-JSON error body - treated as a transient failure below */
  }
  return { ok: false, dead: isDeadTokenResponse(response.status, body), status: response.status };
}

/** Announces a new post to every registered device.
 *
 * Never throws: this is called from the upload path, and a failure to
 * notify must not fail the upload that triggered it. */
async function announcePost(post) {
  try {
    const client = await getClient();
    if (!client) return { sent: 0, skipped: "not configured" };

    const devices = await statements.allPushDevices.all();
    if (devices.length === 0) return { sent: 0 };

    let sent = 0;
    let removed = 0;
    for (let i = 0; i < devices.length; i += BATCH_SIZE) {
      const batch = devices.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (device) => {
          const copy = i18n[device.lang === "en" ? "en" : "sl"];
          const message = {
            notification: {
              title: copy.pushNewPostTitle,
              body: post.title
            },
            // The app routes on this to open the post directly rather
            // than dumping the user on the home screen.
            data: { post_id: String(post.id), url: `https://sejbosejbo.fyi/post/${post.id}` },
            android: { priority: "HIGH" }
          };
          try {
            return { token: device.token, ...(await sendToToken(client, device.token, message)) };
          } catch (err) {
            return { token: device.token, ok: false, dead: false, error: err.message };
          }
        })
      );

      for (const result of results) {
        if (result.ok) sent++;
        else if (result.dead) {
          await statements.deletePushDevice.run(result.token);
          removed++;
        }
      }
    }

    console.log(`[push] post #${post.id}: sent ${sent}/${devices.length}${removed ? `, removed ${removed} dead tokens` : ""}`);
    return { sent, removed };
  } catch (err) {
    console.error(`[push] could not announce post #${post.id}: ${err.message}`);
    return { sent: 0, error: err.message };
  }
}

module.exports = { isConfigured, registerDevice, unregisterDevice, deviceCount, announcePost };
