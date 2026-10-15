# Working context

## Site and deployment

- Project: `sejbosejbo.fyi`, Node/Express application, current source version 1.44.1.
- Production Docker host: `192.168.69.29` (user `ldocker`).
- pfSense/HAProxy terminates HTTPS and forwards traffic to the application.
- The deployed application has an admin-only preview for visible, hidden, held, reported, and soft-deleted posts.

## Current work — 2026-10-15

The user asked for a deep bug review and authorised fixes for all findings except Docker port exposure. Do not change the Docker port binding unless the user explicitly revisits it.

Approved fixes:

1. Use a configured public site URL instead of request Host headers when generating absolute URLs.
2. Force upload file extensions from the accepted MIME type.
3. Reject malformed numeric admin route IDs cleanly.
4. Paginate the admin upload list.
5. Add CSRF protection to browser, cookie-authenticated write routes.

The user requested that this file be updated with useful context in every chat so other agents can continue safely.

## Deployment status

- Source changes are complete locally and passed `node --check` for `server.js` and every `lib/*.js` file.
- 2026-10-15 (second agent): re-verified all five fixes are present (`lib/util.js` `PUBLIC_ORIGIN`, `lib/upload.js` `EXT_BY_MIME`, `pagedUploadsAdmin`, origin-check middleware in `server.js`).
- Found and fixed a regression in the CSRF origin check: `POST /unsubscribe` (RFC 8058 one-click, sent by mail providers with no `Origin`) would have returned 403. It is now exempt — it is token-authorised, not cookie-authorised.
- The origin check compares against `SITE_URL`. Any instance reached on a different origin (local dev on `localhost:3000`, the test stack on port 3050) must set `SITE_URL` to that origin or every browser form POST returns 403.
- The `/tmp/sejbosejbo-1.44.2.tar` archive on the Docker host predates the unsubscribe fix and is **stale** — re-upload before building.
- The final build, Docker Hub publish, and production deployment need explicit user approval because they publish an image externally and modify the live stack.

## Source control

- This Node server workspace is not a Git repository and has no configured GitHub remote.
- `https://github.com/thekingziga/SejboSejbo-APPs` is a separate Flutter app repository. Do not copy server files into it.
- Ask the user for the server repository URL before publishing these server changes to GitHub.
