# sejbosejbo.fyi 🎭

> A deliberately simple, chaotic meme board and anonymous community voting platform.

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen.svg)](https://nodejs.org/)
[![Docker Image](https://img.shields.io/badge/docker-thekingziga%2Fsejbosejbo-blue.svg)](https://hub.docker.com/r/thekingziga/sejbosejbo)
[![Database](https://img.shields.io/badge/database-PostgreSQL%2017-blue.svg)](https://www.postgresql.org/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## ✨ Features

- 🎭 **Chaotic Meme Feed & Gallery**: Post memes, images, stories, audio clips, and short videos with automatic media preview cards.
- 🗳️ **Device-Keyed Anonymous Voting**: Upvote (*"Sej bo"*) or downvote (*"Sej ne bo"*). Keyed by client device fingerprints with rate-limiting and anti-abuse protection—no account creation required.
- 💬 **Comment Threads**: Anonymous discussions on posts, complete with community voting and spam heuristics.
- 🎨 **Dual Layouts**:
  - **Forum / Booru Grid**: High-density masonry gallery (`HOMEPAGE_LAYOUT=forum`).
  - **Classic Hero**: Highlighted daily awards, featured posts, and community metrics.
- 🛡️ **Automated Content Screening**: Built-in TensorFlow NSFW/nudity screening, AI vision verification, duplicate file hashing, and full `/admin` moderation queue.
- 🤖 **Autonomous AI Copy**: Automatically regenerates daily quotes, slogans, and today's awards using local **Ollama** or hosted **OpenAI-compatible** models (strictly additive with static fallbacks).
- 🌓 **Dark & Light Mode**: Zero-flash theme switcher with high-contrast palette.
- 📱 **REST API Ready**: Complete `/api/v1` JSON endpoints for Flutter, React Native, or native companion apps (see [`docs/api.md`](docs/api.md)).
- 🛍️ **Integrated Marketplace**: Token-authenticated classified listings with photo uploads, inquiry messaging, and offer negotiation.
- 💾 **Pluggable Storage**: Seamlessly run with local disk storage or stream through S3-compatible buckets (MinIO, Cloudflare R2, AWS S3, Backblaze B2) with optional dual-bucket mirroring.

---

## 🚀 Quickstart (Self-Hosting with Docker)

The fastest and recommended way to run your own instance is with **Docker Compose**. It sets up the web application and a persistent PostgreSQL database out of the box.

### 1. Clone the repository

```bash
git clone https://github.com/thekingziga/SejboSejbo-WEB.git
cd SejboSejbo-WEB
```

### 2. Configure environment

Copy the template configuration:

```bash
cp .env.example .env
```

Open `.env` and set your secrets:
- `ADMIN_PASSWORD`: Secret password used to log in at `/admin`.
- `SESSION_SECRET`: A long random string for cookie signing.
- `SITE_URL`: The public URL of your instance (e.g. `https://yourdomain.com` or `http://localhost:3000`).

### 3. Launch the stack

```bash
docker compose up -d
```

Open `http://localhost:3000` in your browser. The admin dashboard is available at `http://localhost:3000/admin`.

To check application health:
```bash
curl http://localhost:3000/health
```

---

## 🛠️ Local Development (Without Docker)

### Prerequisites

- **Node.js**: v22.5.0 or newer
- **PostgreSQL**: v15 or newer (configured with UTF-8 encoding)
- **ffmpeg**: Required for video/audio preview generation and screening

### Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure your database**:
   Create a PostgreSQL database and user:
   ```sql
   CREATE DATABASE sejbosejbo;
   CREATE USER sejbosejbo WITH ENCRYPTED PASSWORD 'sejbosejbopass';
   GRANT ALL PRIVILEGES ON DATABASE sejbosejbo TO sejbosejbo;
   ```

3. **Start the development server**:
   ```bash
   PGHOST=localhost PGPORT=5432 PGUSER=sejbosejbo PGPASSWORD=sejbosejbopass PGDATABASE=sejbosejbo ADMIN_PASSWORD=admin SESSION_SECRET=devsecret npm run dev
   ```

The application automatically checks and applies database table schemas on boot.

---

## ⚙️ Configuration Reference

All settings are configured via environment variables in `.env`:

| Variable | Default | Description |
|---|---|---|
| `SITE_URL` | `http://localhost:3000` | Canonical public URL. Used to generate shareable links and validate CSRF origins. |
| `PORT` | `3000` | Internal port Express listens on. |
| `HOST_PORT` | `3000` | Port mapped on the host by Docker Compose. |
| `ADMIN_PASSWORD` | *(required)* | Password for `/admin`. Refuses to start in production if unset. |
| `SESSION_SECRET` | *(required)* | Key used to sign session cookies. |
| `SITE_TIMEZONE` | `Europe/Ljubljana` | Timezone for display and daily award boundaries. |
| `HOMEPAGE_LAYOUT` | `forum` | `forum` for booru grid layout, or leave blank for classic hero layout. |
| `ENABLE_MEDIA_UPLOADS`| `true` | Allows video (MP4, WebM) and audio uploads in addition to images. |
| `IMAGE_UPLOAD_LIMIT_MB`| `100` | Maximum upload size for images and GIFs. |
| `MEDIA_UPLOAD_LIMIT_MB`| `500` | Maximum upload size for video and audio. |
| `STORAGE_DRIVER` | `local` | `local` (mounts `./uploads`) or `s3` (object storage). |

### PostgreSQL Database Settings

| Variable | Default | Description |
|---|---|---|
| `PGHOST` | `db` | Database hostname or IP. |
| `PGPORT` | `5432` | Database port. |
| `PGUSER` | `sejbosejbo` | Database username. |
| `PGPASSWORD` | `sejbosejbopass` | Database password. |
| `PGDATABASE` | `sejbosejbo` | Database name. |
| `PGPOOL_MAX` | `10` | Maximum concurrent database pool connections. |

### S3 Object Storage (Optional)

When setting `STORAGE_DRIVER=s3`:

```bash
STORAGE_DRIVER=s3
S3_BUCKET=my-sejbosejbo-bucket
S3_ENDPOINT=https://s3.eu-central-1.wasabisys.com
S3_ACCESS_KEY_ID=your-key-id
S3_SECRET_ACCESS_KEY=your-secret-key
S3_REGION=eu-central-1
S3_PUBLIC_BASE_URL=https://cdn.yourdomain.com   # Optional direct CDN origin
```

### AI Copy & Slogan Generator (Optional)

With no AI backend configured, the site falls back to static built-in phrases. You can enable local or cloud LLM copy generation:

#### Using Local Ollama:
```bash
AI_PROVIDER=ollama
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.2:1b
```

#### Using OpenAI or Compatible API:
```bash
AI_PROVIDER=openai
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=your-api-key
AI_MODEL=gpt-4o-mini
```

---

## 🔒 Security & Moderation

- **CSRF & Origin Protection**: All browser cookie-authenticated POST/DELETE actions require valid origin headers matching `SITE_URL`.
- **Pre-upload Moderation**: Images and video keyframes are passed through TensorFlow's NSFW model prior to being published. Flagged uploads are routed to `/admin` for manual approval.
- **Constant-Time Auth**: Password hashing and authentication avoid timing leak attacks.
- **Rate Limiting**: Sliding window rate-limits defend upload, voting, report, and authentication endpoints against abuse.
- **Device Keying**: Anonymous voters generate a device header (`X-Device-Id`), avoiding vote stuffing from single sources.

---

## 📚 REST API

A complete, unauthenticated, and CORS-enabled API lives under `/api/v1` for building companion mobile or desktop apps.

- `GET /api/v1/feed` - Aggregated dashboard (stats, daily winner, top posts, newest posts).
- `GET /api/v1/posts` - Paginated posts with sorting (`newest`, `top`, `featured`, `pinned`).
- `GET /api/v1/posts/:id` - Post details.
- `POST /api/v1/posts` - Multipart media and story upload.
- `POST /api/v1/posts/:id/vote` - Upvote / downvote posts.
- `GET /api/v1/posts/:id/comments` - Post comment thread.
- `POST /api/v1/posts/:id/comments` - Submit a comment.
- `GET /api/v1/random-phrase` - Dynamic slogan.

Full schemas and error contracts are detailed in [`docs/api.md`](docs/api.md).

---

## 🤝 Contributing & License

Contributions, bug reports, and pull requests are welcome!

Distributed under the **MIT License**. See `LICENSE` for details.
