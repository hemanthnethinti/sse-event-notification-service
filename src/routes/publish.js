const express = require("express");

function parseInteger(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
}

function parseString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function createPublishRouter({ eventService }) {
  const router = express.Router();

  router.post("/publish", async (req, res, next) => {
    try {
      await eventService.publish({
        channel: parseString(req.body.channel),
        eventType: parseString(req.body.eventType),
        payload: req.body.payload,
      });
      res.status(202).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/history", async (req, res, next) => {
    try {
      const limit =
        req.query.limit === undefined ? undefined : parseInteger(req.query.limit);
      const afterId =
        req.query.afterId === undefined ? undefined : parseInteger(req.query.afterId);

      const response = await eventService.getHistory({
        channel: parseString(req.query.channel),
        afterId,
        limit,
      });

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = {
  createPublishRouter,
};
