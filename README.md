# Video Sync Service

Production-ready service that syncs videos between storage and streaming platforms (S3, Vimeo, Gumlet, Cloudflare Stream). Supports multiple accounts per platform, full video inventory management, and background sync jobs.

## Features

- **Multi-account provider management** — add multiple S3 buckets, Vimeo accounts, etc.
- **Video inventory** — pull and cache all video metadata from every provider
- **Flexible sync** — sync one video or all videos from any source to any destinations
- **Background jobs** — BullMQ workers with retry, concurrency control, and 6h scheduled refreshes
- **Webhooks** — receive status callbacks from Vimeo, Gumlet, and Cloudflare
- **Encrypted credentials** — AES-256-GCM encryption for stored provider credentials

## Stack

- **Runtime**: Bun
- **HTTP**: Hono
- **Database**: PostgreSQL via Prisma
- **Queue**: BullMQ + Redis
- **Platforms**: AWS S3, Vimeo (TUS + pull), Gumlet, Cloudflare Stream

---

## Quick Start

### Prerequisites

- Bun >= 1.1
- PostgreSQL
- Redis

### 1. Install dependencies

```bash
bun install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values. Required variables:

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/video_sync
REDIS_URL=redis://localhost:6379

# Generate a 64-char hex key: openssl rand -hex 32
ENCRYPTION_KEY=your_64_hex_char_key_here

# Legacy global credentials (still required for backward-compat sync)
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
S3_BUCKET=my-bucket
VIMEO_CLIENT_ID=...
VIMEO_CLIENT_SECRET=...
VIMEO_ACCESS_TOKEN=...
GUMLET_API_KEY=...
GUMLET_COLLECTION_ID=...
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
```

### 3. Run database migrations

```bash
bun run db:migrate
```

### 4. Start the service

```bash
bun run dev          # Development (hot reload)
bun run start        # Production
```

### Docker Compose

```bash
docker-compose up -d
```

---

## API Reference

All endpoints return `{ success: boolean, data?: T, error?: string }`.

### Health

```
GET  /health                     Service health (DB, Redis, all platforms)
GET  /api/queue/stats            BullMQ queue statistics
```

### Provider Management

```
POST   /api/providers            Add a provider
GET    /api/providers            List all providers
GET    /api/providers/:id        Get provider details
PUT    /api/providers/:id        Update provider
DELETE /api/providers/:id        Remove provider
POST   /api/providers/:id/test   Test provider connectivity
POST   /api/providers/:id/sync-videos   Pull all videos from provider into DB
GET    /api/providers/:id/videos        List provider videos from DB
POST   /api/providers/:id/videos/refresh  Re-fetch from platform API
```

#### Add a provider

```bash
# S3 bucket
curl -X POST http://localhost:3000/api/providers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Main S3 Bucket",
    "type": "S3",
    "credentials": {
      "region": "us-east-1",
      "accessKeyId": "AKIA...",
      "secretAccessKey": "...",
      "bucket": "my-videos"
    }
  }'

# Vimeo account
curl -X POST http://localhost:3000/api/providers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Main Vimeo",
    "type": "VIMEO",
    "credentials": {
      "accessToken": "your_vimeo_access_token"
    }
  }'

# Gumlet
curl -X POST http://localhost:3000/api/providers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Gumlet CDN",
    "type": "GUMLET",
    "credentials": {
      "apiKey": "...",
      "collectionId": "optional_collection_id"
    }
  }'

# Cloudflare Stream
curl -X POST http://localhost:3000/api/providers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Cloudflare Stream",
    "type": "CLOUDFLARE",
    "credentials": {
      "accountId": "...",
      "apiToken": "..."
    }
  }'
```

#### Test provider connectivity

```bash
curl -X POST http://localhost:3000/api/providers/PROVIDER_ID/test
```

#### Pull videos from a provider into the DB

```bash
curl -X POST http://localhost:3000/api/providers/PROVIDER_ID/sync-videos
```

---

### Video Data API

```
GET  /api/videos                 List all videos (filters: providerId, status, search, page, limit)
GET  /api/videos/:id             Get video + all provider copies
```

#### List videos

```bash
# All videos
curl http://localhost:3000/api/videos

# Filter by provider
curl "http://localhost:3000/api/videos?providerId=PROVIDER_ID"

# Search by title
curl "http://localhost:3000/api/videos?search=product+demo"

# Paginate
curl "http://localhost:3000/api/videos?page=2&limit=25"
```

---

### Sync API

```
POST   /api/sync/start           Start a sync job
GET    /api/sync                 List sync jobs
GET    /api/sync/stats           Sync statistics
GET    /api/sync/:jobId          Job status + per-provider results
DELETE /api/sync/:jobId          Cancel a pending job
```

#### Start a sync

```bash
# Sync ALL videos from source provider to destinations
curl -X POST http://localhost:3000/api/sync/start \
  -H "Content-Type: application/json" \
  -d '{
    "sourceProviderId": "SOURCE_PROVIDER_ID",
    "destinationProviderIds": ["DEST_PROVIDER_ID_1", "DEST_PROVIDER_ID_2"]
  }'

# Sync a specific video only
curl -X POST http://localhost:3000/api/sync/start \
  -H "Content-Type: application/json" \
  -d '{
    "sourceProviderId": "SOURCE_PROVIDER_ID",
    "destinationProviderIds": ["DEST_PROVIDER_ID"],
    "videoId": "PROVIDER_VIDEO_ID",
    "title": "Override title on destination"
  }'
```

#### Check job status

```bash
curl http://localhost:3000/api/sync/JOB_ID
```

Response includes per-provider results:
```json
{
  "success": true,
  "data": {
    "id": "...",
    "status": "READY",
    "syncResults": [
      {
        "providerId": "...",
        "provider": { "name": "Cloudflare Stream", "type": "CLOUDFLARE" },
        "status": "READY",
        "externalId": "cf-video-uid",
        "urls": {
          "hlsUrl": "https://...",
          "playerUrl": "https://iframe.cloudflarestream.com/..."
        }
      }
    ]
  }
}
```

#### Legacy sync (S3 key → platform enum)

```bash
curl -X POST http://localhost:3000/api/sync \
  -H "Content-Type: application/json" \
  -d '{
    "sourceKey": "videos/my-video.mp4",
    "title": "My Video",
    "destinations": ["VIMEO", "GUMLET", "CLOUDFLARE"]
  }'
```

---

### Webhooks

Configure these URLs in your platform dashboards:

```
POST /api/webhooks/vimeo        Vimeo event callbacks
POST /api/webhooks/gumlet       Gumlet event callbacks
POST /api/webhooks/cloudflare   Cloudflare Stream callbacks
```

Set webhook secrets in `.env`:

```env
WEBHOOK_SECRET_VIMEO=your_secret
WEBHOOK_SECRET_GUMLET=your_secret
WEBHOOK_SECRET_CLOUDFLARE=your_bearer_token
```

---

## Architecture

```
src/
├── index.ts              # Entry: HTTP server + workers + scheduler
├── db.ts                 # Prisma client singleton
├── api/
│   ├── routes.ts         # Main Hono router
│   ├── providers.ts      # Provider CRUD + connectivity test
│   ├── videos.ts         # Video listing across providers
│   ├── sync.ts           # Sync job management
│   └── webhooks.ts       # Platform webhook receivers
├── sync/
│   ├── engine.ts         # Sync orchestrator (legacy + provider modes)
│   └── rules.ts          # Sync rule types
├── providers/
│   ├── types.ts          # ProviderAdapter interface
│   ├── s3.ts             # S3 adapter
│   ├── vimeo.ts          # Vimeo adapter
│   ├── gumlet.ts         # Gumlet adapter
│   ├── cloudflare.ts     # Cloudflare Stream adapter
│   └── index.ts          # Factory: createProviderAdapter()
├── services/             # Legacy services (global-config based)
│   ├── s3.ts, vimeo.ts, gumlet.ts, cloudflare.ts
├── jobs/
│   ├── queue.ts          # BullMQ queue + Redis setup
│   ├── syncJob.ts        # Sync worker
│   └── refreshJob.ts     # Provider refresh worker + scheduler
└── utils/
    ├── config.ts         # Zod env validation
    ├── crypto.ts         # AES-256-GCM for credential encryption
    ├── logger.ts         # Pino logger
    └── retry.ts          # Exponential backoff + polling
```

### Credential Encryption

Provider credentials are stored as AES-256-GCM encrypted JSON. Set `ENCRYPTION_KEY` to a 64-character hex string (32 bytes):

```bash
openssl rand -hex 32
```

The encryption format is: `base64(iv[12] || authTag[16] || ciphertext)`.

### Background Refresh

On startup the service:
1. Enqueues a refresh job for every active provider
2. Sets an interval timer (6h) to re-enqueue refreshes
3. Each refresh job calls `listAllVideos()` and upserts into `ProviderVideo`

You can also trigger a refresh manually:

```bash
curl -X POST http://localhost:3000/api/providers/PROVIDER_ID/videos/refresh
```

---

## Database Schema

Key models:

| Model | Purpose |
|---|---|
| `Provider` | Stores credentials (encrypted) for each platform account |
| `ProviderVideo` | Cached video metadata from each provider |
| `SyncJob` | A sync operation (source → destinations) |
| `SyncJobResult` | Per-destination result for a SyncJob |
| `PlatformResult` | Legacy per-platform result (backward compat) |
| `WebhookEvent` | Raw webhook payloads from platforms |

---

## Development

```bash
bun run db:studio          # Open Prisma Studio
bun run db:migrate         # Apply migrations
bun run type-check         # TypeScript check
bun test                   # Run tests
```
