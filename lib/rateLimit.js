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
      res.status(429).json({ error: message || "Too many requests. Try again later." });
      return;
    }

    arr.push(now);
    next();
  };
}

module.exports = { createRateLimiter };
