# Developer Notes

## What This System Solves

This service provides reliable real-time notifications over Server-Sent Events (SSE).

Clients subscribe to channels and keep one long-lived HTTP stream open. The server pushes matching events to that stream. Every event is persisted in PostgreSQL before delivery, so temporary disconnections do not cause permanent message loss.

Think of the system as two cooperating parts:

- PostgreSQL is the source of truth.
- Redis propagates events across app instances.
- SSE is the per-instance live delivery layer.

## Internal Model

The system is event-driven and has two independent flows: publishing and consumption.

### 1. Publishing Flow

When an event is published, durability happens before fanout.

```text
client request
  -> publish endpoint
  -> EventService.publish
  -> INSERT into events table
  -> publish event payload to Redis channel
  -> each instance receives Redis message
  -> push event to eligible local SSE connections
```

Persisting first is a deliberate design decision. If delivery fails for any client, replay still has a complete history to recover from.

### 2. Consumption Flow

When a client opens the stream endpoint, connection setup is controlled and stateful.

```text
client opens /api/events/stream
  -> validate user and requested channels
  -> validate against user_subscriptions
  -> optional replay using Last-Event-ID
  -> register connection in in-memory registry
  -> keep connection open for live delivery
```

Replay is completed before the connection enters the live fanout set.

## Why Replay Exists

SSE connections are long-lived, not permanent. They can drop due to:

- browser refresh/navigation
- network interruption
- proxy/load balancer idle timeout

To avoid losing messages, the client sends `Last-Event-ID`. The server fetches events where `id > Last-Event-ID` for requested channels and streams them in ascending order. After replay, live streaming resumes.

## Why Database Ordering Matters

Replay correctness depends on a monotonic event identifier.

- `events.id` is `BIGSERIAL` and strictly increasing.
- Replay query uses `id > lastEventId`.
- Index `(channel, id)` keeps replay and history queries efficient for channel-scoped scans.

Without this ordering model, reconnect semantics become ambiguous and expensive.

## How Channel Authorization Works

Users do not automatically receive every channel.

- Subscriptions are stored in `user_subscriptions`.
- Stream requests are validated against this table before connection is accepted.
- During publish, the service verifies connected user IDs are still subscribed before writing to each response.

This ensures live fanout obeys the same authorization rules as stream initialization.

## SSE Connection Lifecycle

Each connection has a clear lifecycle.

### Initialization

The server sets protocol headers:

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `Connection: keep-alive`

Then it performs replay if a valid `Last-Event-ID` is provided.

### Active Streaming

Connection is tracked in an in-memory registry keyed by:

- client id
- channel membership
- user id

Publish flow uses this registry to find live recipients quickly.
Redis ensures every instance runs this lookup against its own local registry.

### Termination

On `close` or `aborted` events, cleanup removes the connection from all indexes and stops heartbeat timers.

This avoids stale sockets and memory leaks.

## Why Heartbeats Exist

Many intermediaries close idle HTTP streams. To keep the SSE session alive, the server sends periodic comment frames:

```text
: heartbeat
```

This keeps traffic flowing without producing a business event.

## Easy-to-Miss Implementation Details

SSE framing must be exact, including the blank line terminator:

```text
id: 42
event: SYSTEM_ALERT
data: {"message":"hello"}

```

If the blank line is missing, clients often buffer instead of dispatching the event.

Other fragile points:

- forgetting to remove disconnected clients from in-memory indexes
- allowing invalid `Last-Event-ID`
- broadcasting without rechecking subscription state

## How To Rebuild This If Code Is Lost

1. Create schema: `users`, `events`, `user_subscriptions` with `(channel, id)` index on events.
2. Build publish endpoint that persists to DB first and returns `202`.
3. Build subscription endpoints and validate stream channels using DB subscriptions.
4. Implement SSE stream with required headers, frame format, replay query, and heartbeat.
5. Add in-memory connection registry keyed by channel and user.
6. On publish, fanout only to currently connected and authorized listeners.
7. Add history endpoint with `afterId` and `limit`.

If these seven pieces are present, behavior will match the current system design.

## Practical Next Improvements

- Add integration tests for replay ordering and disconnect/reconnect recovery.
- Add authentication and token-based authorization policies per channel.
- Add dead-letter handling and retries for transient Redis or DB failures.
