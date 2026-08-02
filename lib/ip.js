/** Behind Cloudflare, req.ip / req.socket.remoteAddress is Cloudflare's edge
 * IP, not the visitor's - every request looks like it comes from the same
 * handful of addresses. CF-Connecting-IP carries the real client IP and is
 * set by Cloudflare itself (stripped from anything the client sent), so it
 * can't be spoofed by the caller as long as the origin only accepts traffic
 * that actually came through Cloudflare. Falls back to req.ip for local dev
 * and any request that somehow reaches the origin directly. */
function getClientIp(req) {
  const header = req.headers["cf-connecting-ip"];
  if (header) return String(header).split(",")[0].trim();
  return req.ip;
}

module.exports = { getClientIp };
