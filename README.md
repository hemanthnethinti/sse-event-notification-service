# Real-Time SSE Notification Service

Backend service for real-time event delivery using Server-Sent Events (SSE), with PostgreSQL-backed persistence and replay using `Last-Event-ID`.

## Overview

This project implements a production-style notification pipeline where:

1. Events are published through a REST API.
2. Every event is persisted in PostgreSQL.
3. Connected SSE clients receive real-time events.
4. Reconnecting clients can replay missed events from durable storage.

The service enforces channel-level subscriptions per user, supports heartbeat comments for long-lived connections, and includes a paginated history API.

## Quick Start (Docker)

### Prerequisites

- Docker Desktop (or Docker Engine + Compose)

### Start everything

```bash
docker compose up --build
```

### Expected services

- App: `http://localhost:8080`
- DB: `localhost:5432`

### Health check

```bash
curl http://localhost:8080/health
```

Expected response:

```json
{ "status": "ok" }
```

## Local Development

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy values from `.env.example`.

Required variables:

- `DATABASE_URL`
- `REDIS_URL`
- `REDIS_CHANNEL`
- `PORT`

### 3. Run in watch mode

```bash
npm run dev
```

## Architecture

### Components

```text
sse-event-notification-service/
│
├── .env.example
├── .gitignore
├── ARCHITECTURE.md
├── DEV_NOTES.md
├── README.md
├── submission.json
│
├── Dockerfile
├── docker-compose.yml
├── package.json
│
├── seeds/
│   └── 001_init.sql
│
└── src/
    ├── index.js
    ├── db.js
    │
    ├── routes/
    │   ├── publish.js
    │   ├── stream.js
    │   └── subscribe.js
    │
    ├── services/
    │   ├── eventService.js
    │   ├── redisService.js
    │   └── sseService.js
    │
    └── utils/
        └── heartbeat.js
```

- `src/index.js`: composition root, route mounting, error handling, graceful shutdown.
- `src/db.js`: PostgreSQL connection pool.
- `src/services/eventService.js`: business logic for publish, replay, history, and subscriptions.
- `src/services/redisService.js`: Redis pub/sub adapter for distributed fanout across app instances.
- `src/services/sseService.js`: SSE connection registry + SSE frame writing.
- `src/routes/*.js`: transport layer for endpoint parsing/validation and responses.
- `src/utils/heartbeat.js`: 30-second SSE heartbeat scheduler.
- `seeds/001_init.sql`: schema and seed data.

### Data model

#### `events`

- `id BIGSERIAL PRIMARY KEY`
- `channel VARCHAR(255) NOT NULL`
- `event_type VARCHAR(255) NOT NULL`
- `payload JSONB NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- Index: `(channel, id)`

#### `user_subscriptions`

- `user_id INTEGER NOT NULL`
- `channel VARCHAR(255) NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- Composite PK: `(user_id, channel)`

## Features

- SSE stream endpoint with required headers and event format.
- 30-second heartbeat comments (`: heartbeat`).
- Replay support via `Last-Event-ID`.
- Channel subscription management (`subscribe`, `unsubscribe`, list).
- Publish endpoint with durable write-first behavior.
- History endpoint with cursor-style pagination (`afterId`, `limit`).
- Active connection introspection endpoint.
- Dockerized app + PostgreSQL with startup health checks.

## API Surface

- `GET /health`
- `POST /api/events/publish`
- `POST /api/events/channels/subscribe`
- `POST /api/events/channels/unsubscribe`
- `GET /api/events/channels?userId=<id>`
- `GET /api/events/stream?userId=<id>&channels=foo,bar`
- `GET /api/events/history?channel=<name>&afterId=<id>&limit=<n>`
- `GET /api/events/active-connections`

## Verification

```bash
# Run project
docker compose up --build

# Open stream
curl --no-buffer "http://localhost:8080/api/events/stream?userId=1&channels=test-stream-channel"

# Publish event
curl -X POST http://localhost:8080/api/events/publish \
-H "Content-Type: application/json" \
-d '{"channel":"test-stream-channel","eventType":"SYSTEM_ALERT","payload":{"message":"hello"}}'
```

## Verification Walkthrough

### 1. Subscribe user 1

```bash
curl -X POST http://localhost:8080/api/events/channels/subscribe \
	-H "Content-Type: application/json" \
	-d '{"userId":1,"channel":"test-stream-channel"}'
```

### 2. Open SSE stream

```bash
curl --no-buffer "http://localhost:8080/api/events/stream?userId=1&channels=test-stream-channel"
```

### 3. Publish event

```bash
curl -X POST http://localhost:8080/api/events/publish \
	-H "Content-Type: application/json" \
	-d '{"channel":"test-stream-channel","eventType":"SYSTEM_ALERT","payload":{"message":"hello"}}' \
	-i
```

Expected status: `202 Accepted`

### 4. Replay test

Publish multiple events to `replay-channel`, note the last ID you received, then reconnect with:

```bash
curl --no-buffer \
	-H "Last-Event-ID: <last_seen_id>" \
	"http://localhost:8080/api/events/stream?userId=1&channels=replay-channel"
```

### 5. History pagination

```bash
curl "http://localhost:8080/api/events/history?channel=history-channel&limit=5"
curl "http://localhost:8080/api/events/history?channel=history-channel&afterId=<last_id>&limit=5"
```

## Deployment Details

- `docker-compose.yml` orchestrates `app`, `db`, and `redis`.
- `db` runs `seeds/*.sql` automatically on first initialization.
- `redis` carries pub/sub messages so all app instances receive published events.
- `app` waits for `db` health before startup (`depends_on` condition).
- All services include health checks.

## Test Evidence

Run the full contract verification (endpoints, SSE format, filtering, replay, heartbeat):

```bash
npm run contract:test
```

Expected final output line:

```text
All contract checks passed.
```

## Submission Artifacts

Repository contains all required files:

- `Dockerfile`
- `docker-compose.yml`
- `.env.example`
- `seeds/001_init.sql`
- `submission.json`
- full application source in `src/`
