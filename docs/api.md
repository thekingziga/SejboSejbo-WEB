# sejbosejbo.fyi JSON API

Base URL: `https://sejbosejbo.fyi/api/v1`

Build the Flutter app with:

```
--dart-define=API_BASE_URL=https://sejbosejbo.fyi
```

(the app appends `/api/v1` itself).

## Conventions

- All responses are `application/json; charset=utf-8`.
- Errors are `{"error": "human readable message"}` with the matching HTTP status.
- Every `429` carries a **`Retry-After`** header in seconds, and the same
  number as `retry_after_seconds` in the body. It's computed from the sliding
  window, so it's when a slot genuinely frees up - show "try again in N
  seconds" and schedule the retry rather than letting the user hammer it.
- `Cache-Control: no-store` on every response under `/api/v1` - don't cache
  vote counts or feeds client-side beyond your own app state.
- CORS is open (`Access-Control-Allow-Origin: *`) on `/api/v1` only. Native
  builds don't need it; the Flutter web build does.
- Timestamps are ISO 8601 UTC with a `Z` suffix, e.g. `2026-07-19T00:29:00Z`.
- Image URLs are always absolute (`https://sejbosejbo.fyi/uploads/...`).
- `lang` query param: `en` or `sl`, defaults to `en`. Drives `quote`,
  `random-phrase`, and validation-error text.
- No auth on any endpoint - the site is anonymous by design.

## The Post object

```json
{
  "id": 12,
  "title": "Microwaved a salad",
  "description": "It was warm. It was wrong.",
  "kind": "image",
  "image_url": "https://sejbosejbo.fyi/uploads/1784413785433-82067194ba2c0f24.jpg",
  "featured": false,
  "pinned": false,
  "created_at": "2026-07-19T00:29:00Z",
  "upvotes": 128,
  "downvotes": 6,
  "comment_count": 3,
  "my_vote": 1
}
```

- `kind` is `"image"` or `"story"`; `image_url` is `null` for text-only posts.
- `description` is `null`, not `""`, when empty.
- `featured` / `pinned` are real booleans.
- Hidden posts never appear anywhere in this API.
- `upvotes` / `downvotes` are raw counts - derive the score client-side as
  `upvotes - downvotes`; the API doesn't send a precomputed score.
- `comment_count` counts **visible** comments only - hiding a comment in
  admin drops the count immediately, so a card never advertises "3 comments"
  and then opens with two.

### `my_vote` - what this caller already voted

`1` | `-1` | `0`, echoing back the vote stored for your `X-Device-Id`.

**The field is present only when you send an `X-Device-Id` header** on the
request, and it appears on every read that returns posts or comments - feed,
list, detail, comment list - plus the responses to voting, uploading and
commenting.

The omission is deliberate and worth handling explicitly: absent means *"the
server doesn't know who you are"*, which is a different answer from `0`
(*"you haven't voted"*). Don't treat a missing field as unvoted.

Send the header on reads and you can drop client-side vote bookkeeping
entirely - the server is now the source of truth, so a reinstall, a cleared
cache or a second device all show the user's real votes instead of a blank
slate that lets them vote again.

## Reads

### `GET /feed?lang=en`

Everything the dashboard needs in one call. Does **not** increment the
website's human visitor counter.

```json
{
  "stats": { "visits": 1337, "uploads": 42, "days_since_last": 3 },
  "quote": "That's a certified Sejbosejbo.",
  "daily": { "...": "Post, or null" },
  "posts": [ "4 newest visible Posts, pinned first" ],
  "top": [ "3 highest (upvotes - downvotes) Posts of all time" ]
}
```

`days_since_last` is `null` when there are no posts yet.

### `GET /posts?page=1&per_page=24&sort=newest&lang=en`

```json
{ "items": [ "Posts" ], "page": 1, "per_page": 24, "has_next": true }
```

- `per_page` clamps to 50.
- `page` beyond the end returns `items: []`, `has_next: false` - not a 404.
- `sort`: `newest` (default, pure date order - **not** pinned-first, see
  below) | `top` (by score, `id` tie-break for stable pagination) |
  `featured` (only `featured: true`, newest first) | `pinned` (only
  `pinned: true`, newest first). Unknown values fall back to `newest`.

`pinned` stays in the Post object regardless of sort - it's just data, use it
to show a badge. `sort=newest` deliberately ignores it: a 19-day-old pinned
post outranking today's post in a tab labelled "newest" reads as broken to a
user even though it's doing what pinning asked for. Pin something and it
shows up in `sort=pinned`, not by jumping the newest queue. (The *website's*
own `/gallery` page still shows pinned posts first on its default view -
that's an intentional difference in the HTML, not a bug in the API.)

### `GET /posts/:id`

A single Post, or `404 {"error": "..."}`.

### `GET /random-phrase?lang=en`

```json
{ "phrase": "Certified Sejbosejbo" }
```

> **Apps built before media uploads:** `kind` used to be only `"image"` or
> `"story"`. It can now also be `"video"` or `"audio"`, and `image_url`
> points at that file whatever it is. A client that feeds every
> `image_url` to an image decoder will fail on those posts - branch on
> `kind` before rendering. This is the one change that needs handling
> rather than merely being available.

## Writes

### `POST /posts` — multipart/form-data

- `title` - required, trimmed, max 120 chars.
- `description` - optional, trimmed, max 1200 chars.
- `image` - optional. The field is still called `image` for compatibility,
  but it now takes audio and video too.
- Need a title, and at least one of description or image.

| | accepted | limit |
| --- | --- | --- |
| image | jpeg, png, gif, webp | **100 MB** |
| audio | mp3, m4a, ogg, wav, weba | **500 MB** |
| video | mp4, webm, mov | **500 MB** |

Every upload is screened before it is published (a local nudity model
plus a vision model; see `lib/moderation.js`), so the request now also
waits a few seconds after the bytes are in. Send `X-Device-Id` - it is how
the hourly limit is counted per device as well as per IP.

| status | body | when |
| --- | --- | --- |
| `201` | the created Post | clean - it is live |
| `202` | `{"status": "held", "message": "..."}` | saved but **hidden until an admin approves it**. There is no post to open yet: show `message` and go back to the feed |
| `400` | `{"error", "code": "missing"}` | missing title, or neither description nor file |
| `409` | `{"error", "code": "duplicate"}` | this exact file has been posted before |
| `413` | `{"error", "code": "too_large"}` | file is over the limit **for its type** - the message names both the file's size and the ceiling |
| `415` | `{"error"}` | file type not accepted |
| `422` | `{"error", "code": "repost"}` | a video downloaded from another social network (TikTok, Instagram, YouTube...) |
| `429` | `{"error", "code": "rate_limited", "retry_after_seconds"}` | 3 posts an hour, per IP **and** per device |
| `503` | `{"error", "code": "uploads_paused"}` | uploads are switched off |

Every `error` and `message` is in the caller's language (`?lang=sl` for
Slovenian), suitable for showing to the user as-is. A failed upload does
not use up one of the three; a duplicate or a repost does.

A large upload can take minutes on a phone connection. The request stays
open for the whole transfer, so use a generous client timeout and show
progress from the bytes sent rather than assuming a hung request.

### `POST /posts/:id/vote`

Header: `X-Device-Id: <a UUID or similar the app generates once and reuses>`
(8-128 chars, `[A-Za-z0-9_-]`). Missing/malformed → `400`.

Body:

```json
{ "value": 1 }
```

`1` = sej bo, `-1` = sej ne bo, `0` = withdraw. Anything else → `400`.

Returns the **full updated Post** so the app can replace its optimistic
guess with the real counts. One vote per `(post, device)` - voting again
updates rather than duplicates.

This is soft protection, not security: clearing app storage or forging the
header lets anyone re-vote. Treat counts as indicative, not authoritative.
**Rate limited: 60 votes / min per IP → `429`.**

### `POST /posts/:id/report`

Required by Google Play's User Generated Content policy and Apple's
Guideline 1.2 - both require an in-app way to flag objectionable content.
**The app must expose this**, not just the website.

Body:

```json
{ "reason": "spam", "details": "optional, max 500 chars" }
```

`reason` is one of `spam` | `inappropriate` | `harassment` | `copyright` |
`other`. Anything else → `400`. No `X-Device-Id` required - repeated
reports from the same device are a legitimate stronger signal, not abuse.

`201 {"ok": true}` on success, `404` if the post doesn't exist.
**Rate limited: 20 reports / hour per IP → `429`.**

Reports don't hide or remove anything automatically - they queue for a
human (site admin) to review at `/admin?filter=reported`.

### `GET /posts/:id/comments?page=1&per_page=50&sort=oldest`

```json
{ "items": [ { "id": 3, "post_id": 12, "body": "...", "created_at": "2026-08-14T01:41:04Z",
               "upvotes": 4, "downvotes": 0, "my_vote": 0 } ],
  "page": 1, "per_page": 50, "total": 3, "sort": "oldest", "has_next": false }
```

`per_page` clamps to 100. Hidden comments never appear.

`sort`: `oldest` (default, reading order) | `top` (by `upvotes - downvotes`,
oldest-first tie-break for stable pagination). Unknown values fall back to
`oldest`, and the response echoes the `sort` actually applied. The default
stays chronological on purpose - a thread is a conversation, and `top` is
the opt-in for long ones.

### `POST /posts/:id/comments`

Body: `{"body": "..."}` - required, trimmed, max 1000 chars.

`X-Device-Id` is **optional** here (unlike voting). Send it if you want
the client to be able to recognise its own comments later; comments are
anonymous either way and the server never exposes it.

Every comment is checked before it shows (sexual, hateful, harassing,
spam), so the request waits a couple of seconds.

| status | body | when |
| --- | --- | --- |
| `201` | the created comment | clean - it is live |
| `202` | `{"status": "held", "message": "..."}` | saved but hidden until an admin approves it. Show `message`; do not add it to the list |
| `400` | `{"error"}` | empty or too long |
| `404` | `{"error"}` | the post is gone |
| `409` | `{"error", "code": "duplicate"}` | the same text on the same post in the last hour |
| `429` | `{"error", "retry_after_seconds"}` | 15 / 10 min per IP, and 10 / 10 min per device |

`message` and the `409` error follow `?lang=sl`.

### `POST /comments/:id/vote`

Same contract as post voting. Header `X-Device-Id` is **required** here
(8-128 chars, `[A-Za-z0-9_-]`), unlike posting a comment.

Body: `{"value": 1}` - `1` sej bo, `-1` sej ne bo, `0` withdraw.

Returns the **updated comment** with fresh `upvotes` / `downvotes`.
One vote per `(comment, device)`; voting again updates rather than
duplicates, and deleting a comment cascades its votes away.
**Rate limited: 60 votes / min per IP.**

Comment objects carry `upvotes` and `downvotes`; the Post object gained
`comment_count`.

## Donations

- **iOS / Android / macOS**: use StoreKit / Play Billing, then confirm with
  the app's server-side verify endpoints below - store policy requires this
  and forbids linking out to Stripe from those builds.
- **Windows**: Stripe Checkout in the browser.

All three are **disabled (`503`) until the matching env vars are set** - see
`deploy/.env.example`. Nothing to change in the app; they'll start working
the moment the server is configured.

### `POST /donations/stripe/session`

Body: `{"tier_id": "small" | "medium" | "large"}` → `{"url": "https://checkout.stripe.com/..."}`

Amounts (`small`=€2, `medium`=€5, `large`=€15) come from a server-side map -
never trust a client-supplied amount.

### `POST /donations/apple/verify` / `POST /donations/google/verify`

Body: `{"product_id": "fyi.sejbosejbo.tip.small|medium|large", "token": "..."}`

`200` on a verified purchase.

`400` means the store looked at the receipt and said no. That verdict is
final - the same token gets the same answer - so don't retry it, refund it.

Any `5xx` means we never got a verdict: the store was unreachable or
rate-limited us, our own store credentials expired, or that store's
verification isn't configured yet. The purchase may be perfectly good, so
retry with backoff.

Don't collapse the two. Reading a `5xx` as a rejection refunds real
purchases; retrying a `400` parks a dead receipt in the queue forever.

## Marketplace

The full contract - every field, path and status code - is
`sejbosejbo-app/docs/API_REQUEST_marketplace.md`; the app is built against it.
The implementation is `lib/marketplaceApi.js`, a thin layer over the same
functions the website uses, so the two can never disagree about a rule.

**Deploying these routes turns the app's marketplace tab on in every installed
copy.** The app probes `GET /listings?per_page=1` at launch and shows the tab
once it gets JSON back.

Auth is `Authorization: Bearer <token>`, accepted only under `/api/v1` and
never turned into a cookie:

- `POST /auth/code` `{email, lang}` -> `200 {"ok": true}` whether or not the
  address has an account. Mails a six-digit code, 15 minutes, single use; a new
  code retires the previous one. Shares the website's cap of 3 links-or-codes
  per address per 15 minutes, plus 5 per IP per hour.
- `POST /auth/verify` `{email, code}` -> `{token, user}`, or `400 bad_code`.
  Each guess spends one of five attempts **before** it is compared, so even a
  burst of simultaneous guesses gets five. 20 per IP per 15 minutes.
- `POST /auth/logout` -> `204`. Sessions unused for 90 days are deleted; using
  one counts as logging in for the one-year account purge.

`401 {"code": "unauthorized"}` means only "this token is no good" - the app
signs out on it. Every error is `{"error": "<localised>", "code": "<machine>"}`,
localised by `?lang=`.

| Route | |
|---|---|
| `GET/PATCH/DELETE /me` | account; `DELETE` is the in-app deletion Play requires |
| `GET /me/blocks`, `DELETE /me/blocks/:user_id` | |
| `GET /listings?page&per_page&q&sort` | `sort` = `new`, `price_asc`, `price_desc`; echoes what was applied |
| `GET /listings/:id` | |
| `GET /me/listings` | the caller's own listings, including ones the public cannot see: `hidden: true` means it is not shown to anyone else (an admin hid it, or `held: true` - it is waiting for review). Don't link a hidden one to its public page; it 404s |
| `POST /listings` | multipart `title`, `description`, `price`, `photo` - the web form's fields. The photo and text are screened first: `201` with the listing when clean, or `202` `{"status": "held", "id", "message"}` when it is saved hidden for review (show `message`; it appears in the seller's own list, not publicly) |
| `POST /listings/:id/sold`, `DELETE /listings/:id` | owner only (`403` otherwise) |
| `POST /listings/:id/report` | no token needed |
| `POST /listings/:id/messages` | starts or continues the caller's thread |
| `GET /conversations`, `GET /conversations/:id?after=<id>` | `after` polls cheaply; a poll that finds nothing writes nothing |
| `POST /conversations/:id/messages`, `.../offers/:message_id`, `.../report`, `.../block` | |

Blocking works both ways and is enforced inside `lib/marketplace.js`, so it
holds on the website too. A blocked person just gets `409 closed`.

No response ever contains another user's email - only `GET /me` returns the
caller's own.

Unknown `/api/v1` paths answer `404 {"code": "not_found"}` in JSON rather than
redirecting to the website's 404 page.

## Deep links

`https://sejbosejbo.fyi/post/<id>` should open the app once it's registered.
`GET /.well-known/apple-app-site-association` and
`GET /.well-known/assetlinks.json` serve the association files once
`APPLE_TEAM_ID` / `ANDROID_CERT_SHA256` are set; until then they `404` and
shared links just open the website, which is a fine fallback.
