/** In-memory fixed-key sliding window limiter. Fine for a single Node
 * process on one Pi - there's no cross-instance state to share. Resets on
 * restart, which is an acceptable trade for not adding Redis to a
 * deliberately simple app. */
function createRateLimiter({ windowMs, max, keyFn, message }) {
  const hits = new Map(); // key -> sorted array of hit timestamps

  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, arr] of hits) {
      while (arr.length && arr[0] <= cutoff) arr.shift();
      if (arr.length === 0) hits.delete(key);
    }
  }, Math.min(windowMs, 60000)).unref();

  return function rateLimit(req, res, next) {
    const key = keyFn(req);
    const now = Date.now();
    const cutoff = now - windowMs;
    let arr = hits.get(key);
    if (!arr) {
      arr = [];
      hits.set(key, arr);
    }
    while (arr.length && arr[0] <= cutoff) arr.shift();

    if (arr.length >= max) {
      // The window is sliding, so a slot frees up when the OLDEST hit ages
      // out - not when the whole window elapses. Rounded up so we never
      // advertise a moment that's still a millisecond too early and hand
      // the client a second 429.
      const retryAfter = Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        error: message || "Too many requests. Try again later.",
        retry_after_seconds: retryAfter
      });
      return;
    }

    arr.push(now);
    next();
  };
}

module.exports = { createRateLimiter };
