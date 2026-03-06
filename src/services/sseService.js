class SseService {
  constructor() {
    this.clients = new Map();
    this.channelIndex = new Map();
    this.userIndex = new Map();
    this.nextClientId = 1;
  }

  setupHeaders(res) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
  }

  writeEvent(res, event) {
    const eventId = String(event.id).replace(/[\r\n]+/g, " ");
    const eventType = String(event.eventType).replace(/[\r\n]+/g, " ");
    const data = JSON.stringify(event.payload);

    try {
      res.write(`id: ${eventId}\n`);
      res.write(`event: ${eventType}\n`);
      res.write(`data: ${data}\n\n`);
      return true;
    } catch (_error) {
      return false;
    }
  }

  writeHeartbeat(res) {
    try {
      res.write(": heartbeat\n\n");
      return true;
    } catch (_error) {
      return false;
    }
  }

  addConnection({ userId, channels, res }) {
    const clientId = this.nextClientId;
    this.nextClientId += 1;

    const channelSet = new Set(channels);
    const client = {
      id: clientId,
      userId,
      channels: channelSet,
      res,
    };

    this.clients.set(clientId, client);

    for (const channel of channelSet) {
      if (!this.channelIndex.has(channel)) {
        this.channelIndex.set(channel, new Set());
      }
      this.channelIndex.get(channel).add(clientId);
    }

    if (!this.userIndex.has(userId)) {
      this.userIndex.set(userId, new Set());
    }
    this.userIndex.get(userId).add(clientId);

    return clientId;
  }

  removeConnection(clientId) {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    for (const channel of client.channels) {
      const clientIds = this.channelIndex.get(channel);
      if (clientIds) {
        clientIds.delete(clientId);
        if (clientIds.size === 0) {
          this.channelIndex.delete(channel);
        }
      }
    }

    const userClientIds = this.userIndex.get(client.userId);
    if (userClientIds) {
      userClientIds.delete(clientId);
      if (userClientIds.size === 0) {
        this.userIndex.delete(client.userId);
      }
    }

    this.clients.delete(clientId);
  }

  removeChannelFromUserConnections(userId, channel) {
    const userClientIds = this.userIndex.get(userId);
    if (!userClientIds) {
      return;
    }

    for (const clientId of userClientIds) {
      const client = this.clients.get(clientId);
      if (!client || !client.channels.has(channel)) {
        continue;
      }

      client.channels.delete(channel);

      const channelClientIds = this.channelIndex.get(channel);
      if (channelClientIds) {
        channelClientIds.delete(clientId);
        if (channelClientIds.size === 0) {
          this.channelIndex.delete(channel);
        }
      }
    }
  }

  getConnectionsByChannel(channel) {
    const clientIds = this.channelIndex.get(channel);
    if (!clientIds) {
      return [];
    }

    const clients = [];
    for (const clientId of clientIds) {
      const client = this.clients.get(clientId);
      if (client) {
        clients.push(client);
      }
    }

    return clients;
  }

  getActiveConnectionSummary() {
    const byChannel = {};
    for (const [channel, clientIds] of this.channelIndex.entries()) {
      byChannel[channel] = clientIds.size;
    }

    return {
      activeConnections: this.clients.size,
      byChannel,
    };
  }
}

module.exports = {
  SseService,
};
