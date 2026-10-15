# Working context

## Site and deployment

- Project: `sejbosejbo.fyi`, Node/Express application, current source version 1.44.2.
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
5. Add CSRF protection to browser, cookie-authenticated write routes (with /unsubscribe token-based exemption).

The user requested that this file be updated with useful context in every chat so other agents can continue safely.

## Deployment status

- Version 1.44.2 was successfully built on the Docker host via BuildKit.
- Published to Docker Hub as `thekingziga/sejbosejbo:1.44.2` and `thekingziga/sejbosejbo:latest`.
- Deployed to the live stack on `192.168.69.29`; `/health` verified reporting `1.44.2`.

## Source control

- Initialized Git repository tracking `https://github.com/thekingziga/SejboSejbo-WEB.git` on branch `main`.
- Reorganized project from legacy `website/` subfolder layout to the root directory layout used by current tooling and Dockerfile.
- Preserved existing documentation in `docs/` (`api.md`, `API_PROMPT.md`, `PRIVACY_PROMPT.md`, `STORE_LISTING.md`).
- Version `1.44.2` committed locally to `main`.
- Ready to push to GitHub as soon as authentication (PAT or Git Credential Manager) is provided.
