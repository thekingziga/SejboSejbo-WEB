/** In-memory sliding-window counters. Fine for a single Node process -
 * there's no cross-instance state to share. Resets on restart, which is an
 * acceptable trade for not adding Redis to a deliberately simple app. */

/** The counter on its own, for callers that decide separately when a
 * request is turned away and when it counts - uploads are refused before
 * the file arrives, but only counted once the post exists. */
function createQuota({ windowMs, max }) {
  const hits = new Map(); // key -> sorted array of hit timestamps

  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, arr] of hits) {
      while (arr.length && arr[0] <= cutoff) arr.shift();
      if (arr.length === 0) hits.delete(key);
    }
  }, Math.min(windowMs, 60000)).unref();

  function current(key) {
    const arr = hits.get(key) || [];
    const cutoff = Date.now() - windowMs;
    while (arr.length && arr[0] <= cutoff) arr.shift();
    return arr;
  }

  return {
    /** Seconds until `key` may go again, or 0 if it may go now. The window
     * slides, so a slot frees up when the OLDEST hit ages out - not when the
     * whole window elapses. Rounded up so we never advertise a moment that
     * is still a millisecond too early and hand the client a second 429. */
    retryAfter(key) {
      const arr = current(key);
      if (arr.length < max) return 0;
      return Math.max(1, Math.ceil((arr[0] + windowMs - Date.now()) / 1000));
    },
    hit(key) {
      const arr = current(key);
      arr.push(Date.now());
      hits.set(key, arr);
    },
    /** Hands back the most recent hit, for a slot that was reserved up
     * front and then turned out not to count. */
    release(key) {
      const arr = hits.get(key);
      if (arr?.length) arr.pop();
    }
  };
}

function createRateLimiter({ windowMs, max, keyFn, message, onLimit }) {
  const quota = createQuota({ windowMs, max });

  return function rateLimit(req, res, next) {
    const key = keyFn(req);
    const retryAfter = quota.retryAfter(key);
    if (retryAfter) {
      res.setHeader("Retry-After", String(retryAfter));
      // The JSON body below is right for the API, but the admin login is
      // an HTML form - handing a browser raw JSON tells the person
      // nothing. onLimit lets that caller render a page instead.
      if (onLimit) return onLimit(req, res, retryAfter);
      res.status(429).json({
        error: message || "Too many requests. Try again later.",
        retry_after_seconds: retryAfter
      });
      return;
    }
    quota.hit(key);
    next();
  };
}

module.exports = { createQuota, createRateLimiter };
