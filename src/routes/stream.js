const express = require("express");
const { startHeartbeat } = require("../utils/heartbeat");

function parseInteger(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
}

function parseChannels(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }

  const unique = new Set(
    value
      .split(",")
      .map((channel) => channel.trim())
      .filter((channel) => channel.length > 0)
  );

  return [...unique];
}

function createStreamRouter({ eventService, sseService }) {
  const router = express.Router();

  router.get("/active-connections", (_req, res) => {
    res.status(200).json(sseService.getActiveConnectionSummary());
  });

  router.get("/stream", async (req, res, next) => {
    try {
      const userId = parseInteger(req.query.userId);
      const channels = parseChannels(req.query.channels);
      const rawLastEventId = req.get("Last-Event-ID");

      let lastEventId = null;
      if (rawLastEventId !== undefined) {
        lastEventId = parseInteger(rawLastEventId);
        if (lastEventId === null) {
          const error = new Error("Last-Event-ID must be a non-negative integer");
          error.statusCode = 400;
          throw error;
        }
      }

      const streamPayload = await eventService.prepareStream({
        userId,
        channels,
        lastEventId,
      });

      sseService.setupHeaders(res);

      for (const event of streamPayload.replayEvents) {
        const replayed = sseService.writeEvent(res, event);
        if (!replayed) {
          return;
        }
      }

      const clientId = sseService.addConnection({
        userId: streamPayload.userId,
        channels: streamPayload.channels,
        res,
      });

      let cleaned = false;
      let stopHeartbeat = null;

      const cleanup = () => {
        if (cleaned) {
          return;
        }
        cleaned = true;
        if (stopHeartbeat) {
          stopHeartbeat();
        }
        sseService.removeConnection(clientId);
      };

      stopHeartbeat = startHeartbeat({
        res,
        writeHeartbeat: (targetRes) => sseService.writeHeartbeat(targetRes),
        onWriteFailure: cleanup,
      });

      req.on("close", cleanup);
      req.on("aborted", cleanup);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = {
  createStreamRouter,
};
