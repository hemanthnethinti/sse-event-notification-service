const { createClient } = require("redis");

class RedisService {
  constructor({ redisUrl, channel }) {
    this.redisUrl = redisUrl;
    this.channel = channel;
    this.publisher = createClient({ url: redisUrl });
    this.subscriber = this.publisher.duplicate();
    this.subscriptionHandler = null;
  }

  async connect() {
    this.publisher.on("error", (error) => {
      console.error("Redis publisher error", error);
    });

    this.subscriber.on("error", (error) => {
      console.error("Redis subscriber error", error);
    });

    await this.publisher.connect();
    await this.subscriber.connect();
  }

  async subscribe(onEvent) {
    this.subscriptionHandler = async (message) => {
      try {
        const event = JSON.parse(message);
        await onEvent(event);
      } catch (error) {
        console.error("Failed to handle Redis message", error);
      }
    };

    await this.subscriber.subscribe(this.channel, this.subscriptionHandler);
  }

  async publishEvent(event) {
    await this.publisher.publish(this.channel, JSON.stringify(event));
  }

  async ping() {
    await this.publisher.ping();
  }

  async close() {
    if (this.subscriptionHandler && this.subscriber.isOpen) {
      await this.subscriber.unsubscribe(this.channel, this.subscriptionHandler);
      this.subscriptionHandler = null;
    }

    if (this.subscriber.isOpen) {
      await this.subscriber.quit();
    }

    if (this.publisher.isOpen) {
      await this.publisher.quit();
    }
  }
}

module.exports = {
  RedisService,
};
