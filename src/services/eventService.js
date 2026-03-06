class EventService {
  constructor({ db, sseService, redisService, instanceId }) {
    this.db = db;
    this.sseService = sseService;
    this.redisService = redisService;
    this.instanceId = instanceId;
    this.DEFAULT_HISTORY_LIMIT = 50;
    this.MAX_HISTORY_LIMIT = 200;
  }

  createHttpError(message, statusCode, details) {
    const error = new Error(message);
    error.statusCode = statusCode;
    if (details !== undefined) {
      error.details = details;
    }
    return error;
  }

  async healthCheck() {
    await this.db.query("SELECT 1");
    await this.redisService.ping();
    return { status: "ok" };
  }

  async fanoutToLocalConnections(event) {
    const { channel } = event;
    const channelClients = this.sseService.getConnectionsByChannel(channel);
    if (channelClients.length === 0) {
      return;
    }

    const connectedUserIds = [...new Set(channelClients.map((client) => client.userId))];
    const subscribedResult = await this.db.query(
      "SELECT user_id FROM user_subscriptions WHERE channel = $1 AND user_id = ANY($2::int[])",
      [channel, connectedUserIds]
    );
    const allowedUsers = new Set(subscribedResult.rows.map((item) => Number(item.user_id)));

    for (const client of channelClients) {
      if (!allowedUsers.has(Number(client.userId)) || !client.channels.has(channel)) {
        continue;
      }

      const wrote = this.sseService.writeEvent(client.res, {
        id: event.id,
        eventType: event.eventType,
        payload: event.payload,
      });

      if (!wrote) {
        this.sseService.removeConnection(client.id);
      }
    }
  }

  async handleDistributedEvent(event) {
    if (!event || !event.channel || !event.eventType) {
      return;
    }

    if (event.originInstanceId && event.originInstanceId === this.instanceId) {
      return;
    }

    await this.fanoutToLocalConnections(event);
  }

  async userExists(userId) {
    const result = await this.db.query("SELECT 1 FROM users WHERE id = $1", [userId]);
    return result.rowCount > 0;
  }

  async subscribe({ userId, channel }) {
    if (!userId || !channel) {
      throw this.createHttpError("userId and channel are required", 400);
    }

    const exists = await this.userExists(userId);
    if (!exists) {
      throw this.createHttpError("User not found", 404);
    }

    await this.db.query(
      "INSERT INTO user_subscriptions (user_id, channel) VALUES ($1, $2) ON CONFLICT (user_id, channel) DO NOTHING",
      [userId, channel]
    );

    return {
      status: "subscribed",
      userId,
      channel,
    };
  }

  async unsubscribe({ userId, channel }) {
    if (!userId || !channel) {
      throw this.createHttpError("userId and channel are required", 400);
    }

    await this.db.query("DELETE FROM user_subscriptions WHERE user_id = $1 AND channel = $2", [
      userId,
      channel,
    ]);

    this.sseService.removeChannelFromUserConnections(userId, channel);

    return {
      status: "unsubscribed",
      userId,
      channel,
    };
  }

  async listChannels({ userId }) {
    if (!userId) {
      throw this.createHttpError("userId query parameter is required", 400);
    }

    const result = await this.db.query(
      "SELECT channel, created_at FROM user_subscriptions WHERE user_id = $1 ORDER BY channel ASC",
      [userId]
    );

    return {
      userId,
      channels: result.rows.map((row) => ({
        channel: row.channel,
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  async publish({ channel, eventType, payload }) {
    const payloadIsObject = payload !== null && typeof payload === "object";
    if (!channel || !eventType || !payloadIsObject) {
      throw this.createHttpError("channel, eventType, and payload (object) are required", 400);
    }

    const insertResult = await this.db.query(
      "INSERT INTO events (channel, event_type, payload) VALUES ($1, $2, $3::jsonb) RETURNING id, channel, event_type, payload, created_at",
      [channel, eventType, JSON.stringify(payload)]
    );

    const row = insertResult.rows[0];
    const distributedEvent = {
      id: row.id,
      channel: row.channel,
      eventType: row.event_type,
      payload: row.payload,
      createdAt: row.created_at.toISOString(),
      originInstanceId: this.instanceId,
    };

    await this.redisService.publishEvent(distributedEvent);
    await this.fanoutToLocalConnections(distributedEvent);
  }

  async getHistory({ channel, afterId, limit }) {
    if (!channel) {
      throw this.createHttpError("channel query parameter is required", 400);
    }

    const safeAfterId = afterId ?? 0;
    if (safeAfterId < 0) {
      throw this.createHttpError("afterId must be a non-negative integer", 400);
    }

    const safeLimit = limit ?? this.DEFAULT_HISTORY_LIMIT;
    if (safeLimit <= 0) {
      throw this.createHttpError("limit must be a positive integer", 400);
    }

    const result = await this.db.query(
      "SELECT id, channel, event_type, payload, created_at FROM events WHERE channel = $1 AND id > $2 ORDER BY id ASC LIMIT $3",
      [channel, safeAfterId, Math.min(safeLimit, this.MAX_HISTORY_LIMIT)]
    );

    return {
      events: result.rows.map((row) => ({
        id: row.id,
        channel: row.channel,
        eventType: row.event_type,
        payload: row.payload,
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  async prepareStream({ userId, channels, lastEventId }) {
    if (!userId || channels.length === 0) {
      throw this.createHttpError("userId and channels query parameters are required", 400);
    }

    const exists = await this.userExists(userId);
    if (!exists) {
      throw this.createHttpError("User not found", 404);
    }

    const subscribedResult = await this.db.query(
      "SELECT channel FROM user_subscriptions WHERE user_id = $1 AND channel = ANY($2::varchar[])",
      [userId, channels]
    );
    const subscribedChannels = new Set(subscribedResult.rows.map((row) => row.channel));
    const missingChannels = channels.filter((channel) => !subscribedChannels.has(channel));

    if (missingChannels.length > 0) {
      throw this.createHttpError("User is not subscribed to all requested channels", 403, {
        missingChannels,
      });
    }

    if (lastEventId !== null && lastEventId < 0) {
      throw this.createHttpError("Last-Event-ID must be a non-negative integer", 400);
    }

    let replayEvents = [];
    if (lastEventId !== null) {
      const replayResult = await this.db.query(
        "SELECT id, channel, event_type, payload, created_at FROM events WHERE channel = ANY($1::varchar[]) AND id > $2 ORDER BY id ASC",
        [channels, lastEventId]
      );

      replayEvents = replayResult.rows.map((row) => ({
        id: row.id,
        channel: row.channel,
        eventType: row.event_type,
        payload: row.payload,
        createdAt: row.created_at.toISOString(),
      }));
    }

    return {
      userId,
      channels,
      replayEvents,
    };
  }
}

module.exports = {
  EventService,
};
