# Architecture

## System Diagram

```text
Client
  |
  v
API
  |
  v
PostgreSQL (durable write)
  |
  v
Redis Pub/Sub
  |
  +--> Node Instance A -> SSE clients
  |
  +--> Node Instance B -> SSE clients
```

## System Flow

This service follows a write-first event pipeline:

1. Client calls `POST /api/events/publish`.
2. API validates input in route layer.
3. `EventService.publish` persists event into PostgreSQL `events` table.
4. After persistence, the service publishes the event to a Redis channel.
5. Every app instance receives the Redis message through a subscriber client.
6. Each instance cross-checks currently connected users against `user_subscriptions`.
7. Eligible local clients receive the event over SSE.

```text
Client
  |
  | POST /api/events/publish
  v
Express Route Layer (src/routes)
  |
  v
EventService (src/services/eventService.js)
  |
  | INSERT INTO events
  v
PostgreSQL
  |
  | publish event message
  v
Redis Pub/Sub
  |
  | receive message on each instance
  v
SseService (src/services/sseService.js)
  |
  v
Connected SSE Clients
```

## Runtime Components

- `src/index.js`
  - Composition root.
  - Initializes `EventService`, `SseService`, and `RedisService`.
  - Connects Redis publisher/subscriber and registers message handler.
  - Mounts publish, stream, and subscription routes.
  - Handles process shutdown and closes Redis + DB resources.
- `src/db.js`
  - PostgreSQL `pg` pool wrapper (`query`, `closePool`).
- `src/services/eventService.js`
  - Domain logic: publish, replay preparation, history pagination, channel subscription CRUD, health check, Redis-message fanout.
- `src/services/redisService.js`
  - Redis pub/sub wrapper for cross-instance fanout (`publishEvent`, `subscribe`, `ping`, `close`).
- `src/services/sseService.js`
  - SSE transport concerns: headers, frame writing, heartbeat writing, connection index, per-channel lookups.
- `src/routes/*.js`
  - HTTP transport boundary. Parses query/body values and maps service output to HTTP response codes.
- `src/utils/heartbeat.js`
  - Centralized 30-second heartbeat loop for SSE connections.

## SSE Connection Lifecycle

1. Client opens `GET /api/events/stream?userId=...&channels=a,b`.
2. `stream` route parses `userId`, channels, and optional `Last-Event-ID`.
3. `eventService.prepareStream` validates:
   - user exists,
   - requested channels are subscribed,
   - `Last-Event-ID` is valid when provided.
4. `sseService.setupHeaders` writes:
   - `Content-Type: text/event-stream`
   - `Cache-Control: no-cache`
   - `Connection: keep-alive`
5. Replay events (if any) are streamed first.
6. Live connection is registered in `SseService` indices:
   - `clients`
   - `channelIndex`
   - `userIndex`
7. Heartbeat loop sends `: heartbeat\n\n` every 30 seconds.
8. On close/abort/write-failure, cleanup removes connection and stops heartbeat timer.

## Event Replay Mechanism

Replay is based on the SSE standard `Last-Event-ID` header.

- Query shape:
  - `WHERE channel = ANY($1::varchar[]) AND id > $2 ORDER BY id ASC`
- Behavior:
  - Replays all missed events in ascending `id` order before live streaming starts.
  - Live events continue through Redis pub/sub fanout after replay completion.

This guarantees temporal order per numeric event id and minimizes client-side gap handling complexity.

## Database Design

### Tables

### `events`

- `id BIGSERIAL PRIMARY KEY`
- `channel VARCHAR(255) NOT NULL`
- `event_type VARCHAR(255) NOT NULL`
- `payload JSONB NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

### `user_subscriptions`

- `user_id INTEGER NOT NULL`
- `channel VARCHAR(255) NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- Composite primary key `(user_id, channel)`

### `users`

- Seeded user registry used for validation in this assignment.

## Indexing Strategy

- `events(channel, id)` is required for efficient replay and history scans.
- Composite PK on `user_subscriptions(user_id, channel)` enforces uniqueness and supports subscription lookups.

## Consistency and Delivery Model

Delivery semantics are effectively at-least-once from server perspective:

- Event is persisted before broadcast.
- Client reconnect + replay ensures missed messages are recoverable.
- A client can still see duplicates across reconnect boundaries, so consumers should treat `id` as idempotency key.

## Security/Authorization Model (Task Scope)

Within task scope, authorization is subscription-based:

- A stream request is accepted only if the user is subscribed to all requested channels.
- Publish fanout verifies active clients against DB subscriptions before sending.

No token-based authentication is implemented in this assignment.

## Scalability Considerations

Current implementation supports multi-instance fanout.

Scale characteristics:

- Active SSE connections stay local to each process.
- Redis propagates each published event to every process.
- Horizontal scaling works without changing publish semantics.
- Optional sticky sessions still help connection locality but are not required for correctness.

## Failure Modes and Safeguards

- Closed/broken response stream: detected by failed write, connection removed.
- Idle timeout risk: mitigated by heartbeat comments every 30 seconds.
- Invalid stream parameters: explicit 400 responses.
- Unsubscribed access attempts: 403 with `missingChannels` details.
- Redis unavailable: startup fails fast so the service does not run in partially degraded fanout mode.
- Graceful shutdown: server close + Redis close + DB pool close in `src/index.js`.
