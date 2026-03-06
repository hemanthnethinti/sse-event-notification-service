const express = require("express");

const db = require("./db");
const { EventService } = require("./services/eventService");
const { RedisService } = require("./services/redisService");
const { SseService } = require("./services/sseService");
const { createPublishRouter } = require("./routes/publish");
const { createStreamRouter } = require("./routes/stream");
const { createSubscribeRouter } = require("./routes/subscribe");

const app = express();
const sseService = new SseService();
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const redisChannel = process.env.REDIS_CHANNEL || "events:published";
const instanceId = process.env.INSTANCE_ID || `${process.pid}`;
const redisService = new RedisService({ redisUrl, channel: redisChannel });
const eventService = new EventService({ db, sseService, redisService, instanceId });

app.use(express.json({ limit: "1mb" }));

app.get("/health", async (_req, res, next) => {
  try {
    const response = await eventService.healthCheck();
    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
});

app.use("/api/events", createPublishRouter({ eventService }));
app.use("/api/events", createStreamRouter({ eventService, sseService }));
app.use("/api/events", createSubscribeRouter({ eventService }));

app.use((error, _req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  const statusCode = error.statusCode || 500;
  if (statusCode >= 500) {
    console.error(error);
  }

  const body = { error: error.message || "Internal server error" };
  if (error.details !== undefined) {
    body.details = error.details;
  }

  return res.status(statusCode).json(body);
});

const port = Number.parseInt(process.env.PORT, 10) || 8080;
let server = null;

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}. Starting graceful shutdown.`);

  const forceShutdownTimer = setTimeout(() => {
    console.error("Forced shutdown after timeout.");
    process.exit(1);
  }, 10000);
  forceShutdownTimer.unref();

  const closeServer =
    server === null
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });

  try {
    await closeServer;
    await redisService.close();
    await db.closePool();
    clearTimeout(forceShutdownTimer);
    console.log("Shutdown complete.");
    process.exit(0);
  } catch (error) {
    clearTimeout(forceShutdownTimer);
    console.error("Failed to close resources during shutdown.", error);
    process.exit(1);
  }
}

process.on("SIGINT", () => {
  shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

async function start() {
  await redisService.connect();
  await redisService.subscribe((event) => eventService.handleDistributedEvent(event));

  server = app.listen(port, () => {
    console.log(`SSE notification service listening on port ${port}`);
  });
}

start().catch(async (error) => {
  console.error("Failed to start service.", error);

  try {
    await redisService.close();
  } catch (redisError) {
    console.error("Failed to close Redis during startup rollback.", redisError);
  }

  try {
    await db.closePool();
  } catch (dbError) {
    console.error("Failed to close database pool during startup rollback.", dbError);
  }

  process.exit(1);
});
