/** Single source of truth for "who is making this request", used by rate
 * limiting. Node sits behind exactly one hop of reverse proxy - HAProxy on
 * the pfSense box - which is configured with "option forwardfor" so it
 * appends the real client IP to X-Forwarded-For before forwarding here.
 * Express's `trust proxy` is set to `1` in server.js, which tells it to
 * trust exactly that one hop: it always takes the *last* entry in
 * X-Forwarded-For (the one HAProxy itself appended) as req.ip, ignoring
 * anything a client tried to prepend into the header before the request
 * ever reached HAProxy.
 *
 * This used to prefer a Cloudflare-specific header (CF-Connecting-IP), but
 * that's only trustworthy when Cloudflare is guaranteed to be the sole path
 * to the origin - not true here, since the same HAProxy instance also
 * serves domains that don't go through Cloudflare, so the firewall can't be
 * restricted to Cloudflare's ranges. Trusting a named header without also
 * enforcing that path is exactly what makes it spoofable, so this now
 * relies purely on the trust-proxy hop count instead of a specific header
 * name. If Cloudflare proxying is ever re-enabled for this domain with the
 * origin firewalled to Cloudflare's IPs, CF-Connecting-IP could be
 * reintroduced safely - but only alongside that firewall rule, not without
 * it. */
function getClientIp(req) {
  return req.ip;
}

module.exports = { getClientIp };
