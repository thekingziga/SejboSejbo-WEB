# sejbosejbo.fyi

A deliberately simple chaotic meme website for declaring things officially Sejbosejbo.

## Run Locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Admin

The hidden admin page is `/admin`.

Set the password before deploying:

```bash
ADMIN_PASSWORD="change-this" SESSION_SECRET="a-long-random-string" npm start
```

If `ADMIN_PASSWORD` is not set, the local default is `sejbosejbo`.

## Data

- Database: **Postgres** (connection via the `PG*` variables — see `deploy/.env.example`)
- Uploaded images/GIFs: `uploads/`
- `data/` now only holds the legacy `sejbosejbo.sqlite` file, kept as a rollback

`uploads/` and `data/` are ignored by git so the site can keep its archive
separate from the code.

### Moving from SQLite to Postgres

The app used to embed SQLite. It now requires Postgres and will exit on
startup if it cannot reach it — there is no fallback, so that a
misconfigured deployment fails loudly instead of quietly serving an empty
site from a database nobody meant to create.

**Create the database as UTF8.** `SQL_ASCII` stores Slovenian text without
complaint but miscounts and mis-cases it: `length('Čšž')` returns 6, and
`upper('čšž')` returns `čšž` unchanged. ICU with `sl-SI` additionally sorts
č/š/ž correctly:

```sql
CREATE DATABASE sejbosejbo
  WITH OWNER = sejbosejbo TEMPLATE = template0 ENCODING = 'UTF8'
       LOCALE_PROVIDER = icu ICU_LOCALE = 'sl-SI'
       LC_COLLATE = 'C' LC_CTYPE = 'C';
```

Then copy the data across — dry run first:

```bash
docker compose exec sejbosejbo node scripts/migrate-sqlite-to-postgres.js --dry-run
```

Drop `--dry-run` to do it for real. The script preserves row ids (image
filenames and `/post/<id>` links depend on them), truncates and reloads
inside one transaction so a half-finished run can't leave a partial
database, fast-forwards the identity sequences, and verifies row counts
against the source. It opens the SQLite file read-only and never writes to
it, so `data/sejbosejbo.sqlite` remains a valid rollback.

To roll back: point the container at the previous image and the SQLite
file is still exactly as it was.

### Moving uploads to S3

Uploads live on local disk by default. Everything that touches a file goes
through `lib/storage.js`, so switching to an S3-compatible bucket is
configuration, not a code change. Works with your own MinIO/Ceph as well as
R2, B2, Hetzner or AWS — it uses path-style URLs and plain SigV4, with no
AWS SDK installed.

The database is untouched by this: rows store a bare filename, and the
driver decides what URL that becomes. So the switch is reversible.

Order matters — **copy the files first, then flip the driver**, otherwise
existing posts point at objects that aren't in the bucket yet:

1. Put the `S3_*` values in the Pi's `.env` (see `deploy/.env.example`),
   but leave `STORAGE_DRIVER=local` for now.
2. Dry-run the migration to see what would move:

   ```bash
   docker compose exec sejbosejbo sh -c 'STORAGE_DRIVER=s3 node scripts/migrate-uploads-to-s3.js --dry-run'
   ```

3. Run it for real (drop `--dry-run`). It never deletes local files, and
   it's safe to re-run — re-uploading just overwrites identical objects.
4. Set `STORAGE_DRIVER=s3` in `.env`, then
   `docker compose up -d --force-recreate`.
5. Check a post page loads its image from the bucket. Once you're happy,
   the local `uploads/` directory can be archived and removed by hand.

To roll back, set `STORAGE_DRIVER=local` and recreate — the local files are
still there because the migration never deleted them.

A half-configured bucket (driver set to `s3` but a var missing) logs an
error and falls back to local disk rather than taking the site down.

### Mirroring uploads to a second bucket

Set the `S3_MIRROR_*` vars and every upload is written to both buckets, so
losing one provider — or deleting the wrong bucket — doesn't lose the files.

The two writes are deliberately not equal. The **primary must succeed**,
because the database row that gets written points at that object. The
**mirror is best-effort**: if it fails, the upload is still accepted and a
warning is logged. A second bucket exists to make the site more durable, not
to give it a second thing that can reject a post.

That means the mirror can drift. Backfill it the first time, and heal it
afterwards, with:

```bash
docker compose exec sejbosejbo node scripts/migrate-uploads-to-s3.js --mirror
```

Safe to run on a schedule — it re-uploads, which just overwrites identical
objects.

Deletes go to both buckets, so removing a post in admin doesn't leave the
file resurrectable from the mirror.

## Database Backups

`scripts/backup-database.sh` writes a compressed `pg_dump` to `db-backups/`
and prunes anything older than `BACKUP_KEEP_DAYS`. It runs on the host (from
cron), not in the container, and uses the official `postgres` image so the Pi
needs no client tools installed.

```bash
./backup-database.sh            # take a backup
./backup-database.sh --verify   # take one, then restore it into a throwaway
                                # database and print the row counts
```

Installed on the Pi as a nightly job at 03:30 local, with the weekly Sunday
run using `--verify`.

**Why dumps rather than a replica.** A streaming replica protects against the
database *server* dying. It does not protect against the *data* being
destroyed: a dropped table, a bad migration, or deleting the wrong post
replicates to the standby within milliseconds, and then it is gone twice.
These dumps are what lets you go back to how yesterday looked. Run
replication too if you want a hot standby — but only the dumps are a backup.

The script refuses to keep a dump that doesn't contain the schema, so a
silently-empty backup can't sit there looking like success.

To restore:

```bash
gunzip -c db-backups/sejbosejbo-YYYYMMDD-HHMMSS.sql.gz \
  | docker run --rm -i -e PGPASSWORD="$PGPASSWORD" postgres:17-alpine \
      psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE"
```

The dump is taken with `--clean --if-exists`, so it restores straight over an
existing database.

## JSON API

Everything under `/api/v1` is documented in full in
[`docs/api.md`](docs/api.md) - built for a companion app (iOS/Android/macOS/
Windows), same origin as the website, CORS-open, no auth. Quick orientation:

- `GET /api/v1/feed`, `GET /api/v1/posts`, `GET /api/v1/posts/:id`,
  `GET /api/v1/random-phrase` - reads, safe to hit from anywhere.
- `POST /api/v1/posts` - upload (multipart), rate limited per IP.
- `POST /api/v1/posts/:id/vote` - sej bo / sej ne bo, keyed by an
  `X-Device-Id` header the client mints itself. Soft protection only, not an
  auth system - anyone can reset local storage and vote again.
- `POST /api/v1/donations/*` and `/api/v1/webhooks/stripe` - disabled (503)
  until the Stripe/Apple/Google env vars below are set.

Rate limiting keys off the real client IP, which Express derives from
`X-Forwarded-For` set by HAProxy (`app.set("trust proxy", 1)` in
`server.js`) - this domain sits behind pfSense/HAProxy directly, not
Cloudflare, so HAProxy must have `option forwardfor` enabled on the frontend
or backend handling this site, and Node's port must not be reachable except
through HAProxy. See `lib/ip.js` for why.

## Branding Assets

Live in `public/` and are baked into the image by the Dockerfile's `COPY public ./public`:

- `logo.png` (420x420) - topbar mark, hero, and `og:image` for link previews
- `apple-touch-icon.png` (180x180) - iOS home screen
- `favicon.png` (32x32) - browser tab

To swap the logo, replace all three and rebuild. They are generated from one square
source PNG with a transparent background:

```bash
sips -Z 420 source.png --out public/logo.png
sips -Z 180 source.png --out public/apple-touch-icon.png
sips -Z 32  source.png --out public/favicon.png
```

## Updating A Running Deployment

Code and data are fully separate, so shipping new code never touches the archive:

- Code (`server.js`, `public/`) is baked into the image at build time.
- Data lives in bind mounts on the host - `./data` and `./uploads` next to
  `docker-compose.yml` - so it is never inside the container.

Recreating the container therefore keeps every upload, the visit counter, and the
admin password. The schema uses `CREATE TABLE IF NOT EXISTS`, so existing rows are
left alone on start.

Build and push the new image (see the Docker Hub section), then on the Docker host:

```bash
cd /opt/sejbosejbo && docker compose pull && docker compose up -d
```

Notes:

- Do not delete `/opt/sejbosejbo/data` or `/opt/sejbosejbo/uploads` - those are
  the archive and media files.
- Keep `SESSION_SECRET` in `.env` unchanged, otherwise everyone (including admin)
  gets logged out.
- `deploy/rpi-prepare.js` prepares the source and run folders separately and
  will not overwrite an existing `.env`.
- `/public` is served with a 1 hour cache, so a phone that visited recently may need
  a hard refresh before CSS or logo changes show up. `/api/v1/*` always sends
  `Cache-Control: no-store`.
- New optional env vars for donations and app links live in `.env` - see
  `deploy/.env.example`. Any left blank simply disable that feature (503 on the
  donation endpoints, 404 on the `.well-known` files) rather than breaking startup.

## Admin Panel

`/admin` has three sections now, not just the upload table:

- **dashboard** - the upload table, with an `all` / `reported` filter. Reported
  posts show a per-reason tally and a `clear` button that dismisses the
  report(s) without hiding or deleting the post itself.
- **metrics** - visitor/post/vote counts, reports filed all-time vs currently
  outstanding (filed survives a `clear`, outstanding doesn't), and top posts by
  score.
- **settings** - who gets emailed when a post is reported. This is the only
  admin-configurable setting stored in the database (`settings` table) rather
  than an env var, since it's a preference, not a secret.

Report emails need SMTP credentials in `.env` (`SMTP_HOST`, `SMTP_USER`,
`SMTP_PASS` at minimum) - see `deploy/.env.example`. Leave them unset and
reporting still works, it just won't email anyone; `/admin/settings` shows
whether SMTP is currently configured, and **send test email** delivers a
real message to that address so you can confirm the whole chain works
rather than waiting for a real report.

## Background Music

Drop a track at `public/theme.mp3` and a speaker toggle appears in the
topbar. No file, no button - the player probes for it and stays hidden if
it 404s, so the site ships silent until you add one.

The page lists `public/theme.m4a` **first** and falls back to the mp3, so
replacing only the mp3 changes nothing for most visitors. Regenerate both
from the same source:

```bash
ffmpeg -y -i public/theme.mp3 -map 0:a:0 -c:a aac -b:a 96k -movflags +faststart public/theme.m4a
```

- Plays at 30% volume, looping, `preload="none"` so visitors who never
  unmute download nothing.
- **Browsers block unmuted autoplay.** There is no way around it. The
  player attempts playback on load and, when the browser refuses, starts
  on the visitor's first click/tap/keypress instead.
- The mute choice is stored in `localStorage`, so anyone who turns it off
  stays off on every later visit.

Keep the file small - it is served off a Raspberry Pi on a home
connection. Only visitors who actually unmute ever download it, and nearly
all of them get the AAC, so that is the file whose size matters. The
current track is 195 s: 2.4 MB as m4a, 4.7 MB as mp3. It should loop
cleanly with no fade.

## AI Copy (Ollama)

Optional. With `OLLAMA_HOST` unset the site uses the hand-written phrase
lists in `lib/i18n.js` and behaves exactly as it always has - this is
strictly additive.

When enabled, a timer regenerates copy into the `ai_content` table and
pages read the cached rows:

| What | Refresh |
|---|---|
| Random Quote | every 3 hours |
| Homepage examples (the yellow box) | every 3 hours |
| SEJBOSEJBO button phrases | every 3 hours |
| Today's Sejbosejbo Award | once a day, model picks from the newest 40 posts |

**Nothing calls the model during a page request.** A Pi 4 does CPU-only
inference at a few tokens a second, so generating inline would stall every
page load. Generation happens on a timer; requests only ever read SQLite.

Every failure path falls back to the static lists: no `OLLAMA_HOST`,
unreachable server, malformed output, or a hallucinated post id all leave
the site fully working. `/admin/settings` shows the current status, what
was generated and when, and has manual regenerate buttons plus a **test
connection** button. That test reports which of the three independent
things failed - unreachable host, model not pulled, or generation itself -
instead of a single unhelpful "didn't work".

### Choosing a backend

`AI_PROVIDER=ollama` runs a local Ollama daemon. `AI_PROVIDER=openai`
talks to any OpenAI-compatible `/chat/completions` API. Both share the
same caching, schedule, validation and fallback - only the transport
differs, so switching is one env var.

Hosted is usually the better choice for this workload: a Pi 4 takes ~60s
per generation and the model competes with the website for RAM, while a
hosted call answers in a second or two. Volume is tiny - 49 requests and
roughly 0.4M tokens a month - so cost lands in cents unless you pick a
frontier model.

```text
AI_PROVIDER=openai
AI_BASE_URL=https://nano-gpt.com/api/v1     # no /chat/completions suffix
AI_API_KEY=...
AI_MODEL=...
```

Slovenian is the constraint worth optimising for. It is a low-resource
language, and model size matters far more for it than for English -
sub-2B models produce unusable Slovenian regardless of prompt quality,
which is exactly what happened with qwen2.5:0.5b and llama3.2:1b here.
Prefer a mid-size multilingual model (roughly 10B+) and verify with the
**test connection** button plus a forced regenerate, then read the `sl`
rows in `/admin/settings`.

### Running Ollama locally instead

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.2:1b
```

Ollama binds to `127.0.0.1` by default, which a container cannot reach.
Let it listen on the LAN:

```bash
sudo systemctl edit ollama
```

Add this, keeping the `[Service]` header - without it systemd silently
ignores the lines - then `sudo systemctl daemon-reload && sudo systemctl
restart ollama`:

```text
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_KEEP_ALIVE=0"
```

`OLLAMA_KEEP_ALIVE=0` unloads the model straight after each generation so
it only holds RAM while working - important on a box also serving the
site. Drop it if the machine has RAM to spare; keeping the model warm is
much faster.

Then point `.env` at the host's LAN IP, never `127.0.0.1`:

```text
AI_PROVIDER=ollama
OLLAMA_HOST=http://192.168.69.13:11434
OLLAMA_MODEL=llama3.2:1b
```

## Docker

Build locally:

```bash
docker build -t sejbosejbo:local .
```

Run locally:

```bash
docker run -d \
  --name sejbosejbo \
  -p 3000:3000 \
  -e ADMIN_PASSWORD="change-this-password" \
  -e SESSION_SECRET="change-this-to-a-long-random-string" \
  -v "$(pwd)/data:/app/data" \
  -v "$(pwd)/uploads:/app/uploads" \
  sejbosejbo:local
```

The container needs two persistent folders:

- `/app/data` for the SQLite database
- `/app/uploads` for uploaded images/GIFs

Health check:

```bash
curl http://localhost:3000/health
```

## Docker Hub Build And Push

Published image:

```text
thekingziga/sejbosejbo:latest
thekingziga/sejbosejbo:1.12.0
```

The current deployment runs on the Docker host at `192.168.69.29` as `ldocker`.
Keep SSH credentials in environment variables; never commit them to this project.

Copy the source to the Docker host's build folder (run from the project root):

```bash
rsync -av --exclude node_modules --exclude data --exclude uploads --exclude .git ./ ldocker@192.168.69.29:/opt/sejbosejbo-src/
```

Then on the Docker host, build, publish and deploy:

```bash
cd /opt/sejbosejbo-src && ./scripts/deploy.sh
```

It takes the version from `package.json`, or an explicit one
(`./deploy.sh 1.31.0`), points the compose file at it, and confirms
`/health` reports that version before declaring success.

**Publishing is not optional.** Images used to be built on the Pi and
never pushed, so Docker Hub sat well behind what was actually running and
the only copy of any rollback target lived on the same SD card as
everything else. The script pushes before it deploys, verifies the push
landed, and refuses to deploy an image that did not publish. It also
refuses to overwrite a tag that already exists on the hub - otherwise
"roll back to 1.29.0" stops meaning anything. Use `--no-push` for a
throwaway local build.

Old local images are worth clearing occasionally; they are ~336MB each and
twenty of them had accumulated:

```bash
docker images thekingziga/sejbosejbo --format '{{.Tag}}' | grep -v -x -e latest -e "$(node -p "require('./package.json').version")" | xargs -I{} docker rmi thekingziga/sejbosejbo:{}
```

Only delete what is on the hub - check with
`docker manifest inspect thekingziga/sejbosejbo:<tag>` first.

### Cross-building from a Mac instead

Only needed if the image should also run on `linux/amd64`. Requires Docker Desktop
or OrbStack installed locally:

```bash
docker buildx create --use --name sejbosejbo-builder
docker buildx build --platform linux/amd64,linux/arm64 -t thekingziga/sejbosejbo:latest -t thekingziga/sejbosejbo:1.12.0 --push .
```

If the Pi ever runs a 32-bit OS, add `linux/arm/v7`.

## Security

Response headers are set in `lib/security.js` on every request:
Content-Security-Policy (nonce-based, no `unsafe-inline` for scripts),
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Resource-Policy`,
and HSTS on HTTPS requests only. `X-Powered-By` is disabled.

`style-src` keeps `'unsafe-inline'` because the Sejbometer sets its fill
width as a style attribute and nonces do not apply to style attributes.
Scripts have no such exemption - the one inline block carries the nonce,
and confirm-before-submit is a delegated listener rather than an
`onsubmit` attribute.

If `S3_PUBLIC_BASE_URL` is set, its origin is added to `img-src` and
`media-src` automatically. Serving media from a new origin without that
would show a page of broken images.

- **`/admin/login` is rate limited** to 10 attempts per 15 minutes per
  address, and answers with an HTML page rather than JSON. Both outcomes
  are logged with the client address.
- **The password comparison is constant time**, over SHA-256 digests of
  both sides so the buffers are equal length.
- **`ADMIN_PASSWORD` must be set in production.** It used to fall back to
  a default published in the source; the server now refuses to start
  without it rather than quietly opening the admin panel.
- **The session cookie gets `Secure`** on HTTPS requests. It is only
  conditional so that plain-HTTP local development still keeps a session.

### Vote integrity

`X-Device-Id` is chosen by the client, so a script could invent a new one
per request and vote as often as the per-IP limit allowed. Two defences,
in `lib/device.js`:

1. **Signed ids.** `POST /api/v1/device` mints an HMAC-signed id. Set
   `REQUIRE_SIGNED_DEVICE_ID=true` to reject anything else. It defaults to
   **false** - the Flutter app generates its own ids and is already with
   testers, so enforcing now would break voting for every app user. The
   website mints signed ids today, so the switch can be flipped once the
   app follows.
2. **A cap on distinct devices per address** (`MAX_DEVICES_PER_IP`,
   default 20 per hour). This is the defence that actually costs an
   attacker something, since it holds whether ids are forged, minted in
   bulk, or genuine. The limit is deliberately generous because Slovenian
   mobile carriers put many real subscribers behind one CGNAT address.

Minting is itself rate limited to 10 per address per hour.

## Homepage Layouts

`HOMEPAGE_LAYOUT` in `.env` picks the front page. **This is a one-line
switch either way, with no rebuild:**

| Value | Front page |
|---|---|
| `forum` | booru/forum grid |
| unset (or anything else) | the original hero layout |

```bash
# back to the old style
sed -i 's/^HOMEPAGE_LAYOUT=.*/HOMEPAGE_LAYOUT=/' .env && docker compose up -d
```

Both layouts live in one codebase, so switching is an env var on one
server rather than a branch to keep in sync.

The forum layout keeps everything the classic homepage had - the hero,
the AI examples box, the visitor counter, the SEJBOSEJBO button, the
Sejbometer and the app badges - with the meter and badges moved into
sidebar panels so the grid still starts near the top. It also carries the
gallery's four sort tabs (latest / top / featured / pinned), which is why
`layout()` drops **gallery** from the nav when this layout is on: the
front page already does that job. `/gallery` itself still works, so old
links and the sitemap are unaffected.

The reference design has accounts, tags and a forum. This site has none of
those, so each panel maps to something real rather than faking it:

| Reference | Here |
|---|---|
| Dailyjak | the daily award post |
| Featured Post | the existing `featured` flag |
| Recent Comments | real comments, linked to their posts |
| Random Gem | a random visible post |
| Popular Tags | no tags exist, so: real counters |

Panels with no data render an honest empty state.

Paging is done in the database (`newestUploadsPaged`), not by loading
everything and slicing in JS the way the gallery does. `?page=` beyond the
end clamps to the last real page.

**Page size is fixed at 50** with no picker - a chooser for something
nobody changes is one more control in the way. An old `?show=` link is
simply ignored rather than 400ing.

The nav swaps **gallery** for **home** under this layout: the front page
already does the gallery's job, but with the hero at the top the way back
to it needed to be a link and not just the brand mark.

The footer stats strip is suppressed here (`hideStatsBar`) because the
sidebar already shows all of it - visitor count, archive size, latest
post, daily award, random quote. Every other page still gets it.

## Mobile Notice

A one-time note on phones that the site is built wide, offering the app or
a desktop browser, with the page blurred behind it.

It is **dismissible and shown once per device**, deliberately. Most
visitors arrive on a phone, and an interstitial they cannot get past would
simply lose them - so tapping the backdrop, pressing Escape, or either
button all dismiss it, and it never returns on that device.

The decision is made in JS on viewport width (`max-width: 720px`) rather
than server-side on the user agent, which is wrong often enough to matter.
It is evaluated once at load, so resizing a desktop window narrow will not
summon it mid-session.

The forum layout also overrides the shared topbar on phones: below 620px
the topbar stacks into a column, which costs roughly 320px of header
before any content. That is fine on the classic homepage, which opens with
a full-screen hero anyway, but wrong on a layout whose job is showing
posts - so `.layout-forum` keeps it as a wrapped row (79px).

## Test Server

A full second stack on the Pi, for changes that should not go straight to
production:

```bash
/home/pidocker/test-up.sh test
```

- Port **3050**, its own Postgres in a container on **5433**, loaded from
  the latest backup.
- **Every outbound side effect is disabled**: SMTP, FCM and Stripe are all
  blanked. A test server that can email real subscribers or push to real
  phones is not a test server, and the launcher prints a check confirming
  all three are off.
- Own admin password and session secret.

It shares the S3 bucket, so images display - reads only, unless something
is uploaded there.

## Theme

Light is the default and what every first visit gets. Dark is opt-in via
the toggle in the top-right corner and remembered per device in
`localStorage` under `sejbosejbo_theme`.

The system `prefers-color-scheme` is deliberately **not** followed: the
site is light-by-design, and a visitor arriving to an unexpectedly dark
version of a deliberately garish page is a worse first impression than a
toggle they can find.

A short inline script in `<head>` applies the stored choice **before first
paint**, carrying the CSP nonce. Without it, a dark-mode visitor gets a
white flash on every navigation - which is why it is inline rather than in
`main.js`, which loads at the end of the body.

### Adding colours

Colours live as custom properties on `:root`, overridden under
`[data-theme="dark"]`. Two rules keep the dark theme honest:

1. **Accent fills stay bright in dark mode** (`--hot`, `--pink`,
   `--cyan`). Dimming them flattens the whole look. Anything using one as
   a background therefore pins `color: #000`, because `--text` is
   near-white there.
2. **Anything overriding the fill to `--panel` must set
   `color: var(--text)` back.** Skipping this is what left the report
   button at a 1.27:1 contrast ratio - black ink on a dark panel.

Never introduce a literal colour: the whole reason a dark theme was
awkward to add is that two dozen rules had `#fff` hardcoded.

## Notifications

Two ways to tell people a post landed. Both are triggered from the upload
paths - **the website's own /upload as well as the API**, since most posts
are made through the website and notifying only API uploads would reach
nobody. Both are fired after the response and not awaited: notifying must
never slow down or fail the upload that caused it.

### Push (Firebase Cloud Messaging)

`lib/push.js`, using `google-auth-library` (already a dependency for Play
receipts) rather than the much larger `firebase-admin`.

Set `FCM_SERVICE_ACCOUNT_JSON` to a Firebase service account JSON to turn
delivery on. **Registration works regardless**, so the app can ship before
those credentials exist - every install registered in the meantime gets
the first notification once they do.

| Endpoint | Body |
|---|---|
| `POST /api/v1/push/register` | `{token, platform: "android"\|"ios", lang: "sl"\|"en"}` |
| `POST /api/v1/push/unregister` | `{token}` |

Tokens are unique; re-registering updates `last_seen` rather than
duplicating. When FCM reports a token as `UNREGISTERED`, the row is
deleted, so dead installs don't accumulate and get retried forever.

### Email (double opt-in)

`lib/subscribers.js`. Needs SMTP configured (`SMTP_HOST`, `SMTP_USER`,
`SMTP_PASS`); without it the support page says so instead of collecting
addresses it could never mail.

An address that has only been submitted is **not** a subscriber - anyone
can type someone else's address into a form. Nothing is ever sent to it
except the single confirmation message, and only clicking the link sets
`confirmed_at`. That is what makes this lawful under GDPR rather than a
list of unverified addresses, and it is why `confirmedSubscribers` filters
on `confirmed_at IS NOT NULL`.

Every message carries an unsubscribe link plus `List-Unsubscribe` and
`List-Unsubscribe-Post` headers, so mail clients can offer one-click
unsubscribe. `/unsubscribe` accepts both GET (the link) and POST (the
one-click header). Re-subscribing a confirmed address sends nothing -
otherwise the form would be a way to mail someone repeatedly.

`SITE_URL` must be the public URL, since it builds those links.

Counts for both are on `/admin/metrics`.

## Monitoring

`scripts/healthcheck.sh` runs on the Pi from cron every 5 minutes and
pushes to ntfy when something breaks:

| Check | Fails when |
|---|---|
| site | `/health` doesn't return `ok:true` |
| database | the app container can't query Postgres |
| storage | the primary S3 bucket doesn't answer |
| backup | newest dump is older than 30h, missing, or truncated |
| disk | under 10% free |

Database and storage are checked separately from the site because the
container can be up and serving error pages while either is unreachable -
which is exactly what happened on 18 Aug 2026.

Alerts fire on state *change*, so a fault lasting a day sends one alert
and one recovery notice rather than 288 of each. State lives in
`.healthcheck/`; delete a file there to force the next alert to re-send.

Configure with env vars: `NTFY_URL`, `NTFY_TOPIC` (default `sejbosejbo`),
`NTFY_TOKEN`, `SITE_URL`, `BACKUP_DIR`, `BACKUP_MAX_AGE_HOURS`,
`DISK_MIN_PCT_FREE`.

```bash
*/5 * * * * /home/pidocker/sejbosejbo/healthcheck.sh >> /home/pidocker/sejbosejbo/db-backups/healthcheck.log 2>&1
```

**What it cannot catch:** it runs on the same Pi it watches, so it will
never tell you the Pi is off or the house has lost its connection - a
dead Pi means a dead health check. Covering that needs something outside
the house (an uptime service hitting `/health`, or a second machine
running the same script with `SITE_URL` pointed here).

## Social Share Cards

Posts share a blurred version of their own image at
`/post/:id/preview.jpg` - 1200x630, blurred past recognition, with the
logo composited on top, so a link pasted into a group chat shows there is
a picture without giving the joke away.

Rendering uses `sharp`, is cached in-process and deduplicated by filename
(scrapers arrive in parallel). Cold render on the Pi is ~0.85s, warm
~4ms. Text-only posts and any render failure fall back to the logo.

## Raspberry Pi Compose Layout

Recommended folder:

```text
/opt/sejbosejbo/
  docker-compose.yml
  .env
  data/
  uploads/
```

Example setup:

```bash
mkdir -p /opt/sejbosejbo/data /opt/sejbosejbo/uploads
cd /opt/sejbosejbo
cp /path/to/deploy/docker-compose.yml ./docker-compose.yml
cp /path/to/deploy/.env.example ./.env
nano .env
docker compose up -d
```
