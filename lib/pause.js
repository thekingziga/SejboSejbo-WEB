/** Temporary off switches, read from the environment on every request so
 * flipping one in .env and recreating the container is all it takes.
 *
 * INPUT_PAUSED=true  freezes everything users write that others can see:
 *                    posts, marketplace listings, comments, votes, cap
 *                    worship, marketplace messages and offers, and display
 *                    name changes - on the website and in the app.
 * UPLOADS_PAUSED=true only stops new posts and marketplace listings.
 *
 * Deliberately left working while paused: reading, logging in and out,
 * reporting, blocking, deleting your own listings or account, marking
 * sold, unsubscribing, push registration and donations - the things
 * people need for safety, privacy, or to get out. */
function inputPaused() {
  return process.env.INPUT_PAUSED === "true";
}

function uploadsPaused() {
  return inputPaused() || process.env.UPLOADS_PAUSED === "true";
}

module.exports = { inputPaused, uploadsPaused };
