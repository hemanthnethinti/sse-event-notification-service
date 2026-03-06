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

function createSubscribeRouter({ eventService }) {
  const router = express.Router();

  router.post("/channels/subscribe", async (req, res, next) => {
    try {
      const response = await eventService.subscribe({
        userId: parseInteger(req.body.userId),
        channel: parseString(req.body.channel),
      });
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  });

  router.post("/channels/unsubscribe", async (req, res, next) => {
    try {
      const response = await eventService.unsubscribe({
        userId: parseInteger(req.body.userId),
        channel: parseString(req.body.channel),
      });
      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  });

  router.get("/channels", async (req, res, next) => {
    try {
      const response = await eventService.listChannels({
        userId: parseInteger(req.query.userId),
      });
      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = {
  createSubscribeRouter,
};
