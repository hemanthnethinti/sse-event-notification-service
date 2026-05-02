const http = require("http");
const { URL } = require("url");

const BASE = process.env.BASE_URL || "http://localhost:8080";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function request({ method, path, body, headers = {}, timeoutMs = 10000 }) {
  const url = new URL(path, BASE);
  const payload = body === undefined ? null : JSON.stringify(body);

  const reqHeaders = { ...headers };
  if (payload !== null) {
    reqHeaders["Content-Type"] = "application/json";
    reqHeaders["Content-Length"] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: reqHeaders,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = raw.length > 0 ? JSON.parse(raw) : null;
          } catch (_e) {
            json = null;
          }

          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            raw,
            json,
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timeout for ${method} ${path}`));
    });

    req.on("error", reject);

    if (payload !== null) {
      req.write(payload);
    }

    req.end();
  });
}

function openSse({ path, headers = {} }) {
  const url = new URL(path, BASE);

  const req = http.request({
    method: "GET",
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    headers: {
      Accept: "text/event-stream",
      ...headers,
    },
  });

  let response = null;
  let buffer = "";
  let closed = false;
  const messages = [];
  const comments = [];

  const ready = new Promise((resolve, reject) => {
    req.on("response", (res) => {
      response = res;

      if (res.statusCode !== 200) {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => reject(new Error(`SSE status ${res.statusCode}: ${raw}`)));
        return;
      }

      res.setEncoding("utf8");

      res.on("data", (chunk) => {
        buffer += chunk;
        const parts = buffer.split("\n\n");
        while (parts.length > 1) {
          const rawEvent = parts.shift();
          const lines = rawEvent.split(/\r?\n/);

          let id = null;
          let event = null;
          const dataLines = [];
          let sawComment = false;

          for (const line of lines) {
            if (!line) {
              continue;
            }

            if (line.startsWith(":")) {
              sawComment = true;
              comments.push(line);
              continue;
            }

            if (line.startsWith("id:")) {
              id = line.slice(3).trim();
            } else if (line.startsWith("event:")) {
              event = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trim());
            }
          }

          if (sawComment && dataLines.length === 0) {
            continue;
          }

          if (dataLines.length > 0) {
            const data = dataLines.join("\n");
            let payload = null;
            try {
              payload = JSON.parse(data);
            } catch (_e) {
              payload = data;
            }

            messages.push({ id, event, data, payload });
          }
        }

        buffer = parts[0];
      });

      resolve({
        statusCode: res.statusCode,
        headers: res.headers,
      });
    });

    req.on("error", reject);
  });

  req.end();

  return {
    ready,
    messages,
    comments,
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      if (response) {
        response.destroy();
      }
      req.destroy();
    },
  };
}

async function waitForMessages(stream, minCount, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (stream.messages.length >= minCount) {
      return stream.messages;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${minCount} SSE messages; got ${stream.messages.length}`);
}

async function main() {
  console.log(`Running contract checks against ${BASE}`);

  const health = await request({ method: "GET", path: "/health" });
  assert(health.statusCode === 200, `health status expected 200, got ${health.statusCode}`);

  const subscribe = await request({
    method: "POST",
    path: "/api/events/channels/subscribe",
    body: { userId: 1, channel: "alerts" },
  });
  assert(subscribe.statusCode === 201, `subscribe expected 201, got ${subscribe.statusCode}`);
  assert(subscribe.json && subscribe.json.status === "subscribed", "subscribe body mismatch");

  const unsubscribe = await request({
    method: "POST",
    path: "/api/events/channels/unsubscribe",
    body: { userId: 1, channel: "alerts" },
  });
  assert(unsubscribe.statusCode === 200, `unsubscribe expected 200, got ${unsubscribe.statusCode}`);
  assert(unsubscribe.json && unsubscribe.json.status === "unsubscribed", "unsubscribe body mismatch");

  await request({
    method: "POST",
    path: "/api/events/channels/subscribe",
    body: { userId: 1, channel: "test-stream-channel" },
  });
  await request({
    method: "POST",
    path: "/api/events/channels/subscribe",
    body: { userId: 1, channel: "replay-channel" },
  });

  const stream = openSse({
    path: "/api/events/stream?userId=1&channels=test-stream-channel",
  });
  const streamMeta = await stream.ready;
  assert(streamMeta.statusCode === 200, "stream did not return 200");
  assert(streamMeta.headers["content-type"] && streamMeta.headers["content-type"].includes("text/event-stream"), "stream content-type mismatch");
  assert(streamMeta.headers["cache-control"] === "no-cache", "stream cache-control mismatch");
  assert(streamMeta.headers.connection && streamMeta.headers.connection.toLowerCase().includes("keep-alive"), "stream connection header mismatch");

  const published = await request({
    method: "POST",
    path: "/api/events/publish",
    body: {
      channel: "test-stream-channel",
      eventType: "SYSTEM_ALERT",
      payload: { message: "hello" },
    },
  });
  assert(published.statusCode === 202, `publish expected 202, got ${published.statusCode}`);

  await waitForMessages(stream, 1, 5000);
  const message = stream.messages[0];
  assert(message.id, "streamed message missing id");
  assert(message.event === "SYSTEM_ALERT", `streamed message event mismatch: ${message.event}`);
  assert(message.payload && message.payload.message === "hello", "streamed message payload mismatch");
  stream.close();

  const history1 = await request({ method: "GET", path: "/api/events/history?channel=history-channel&limit=5" });
  assert(history1.statusCode === 200, `history page1 expected 200, got ${history1.statusCode}`);
  assert(Array.isArray(history1.json.events) && history1.json.events.length === 5, "history page1 size mismatch");

  const afterId = history1.json.events[history1.json.events.length - 1].id;
  const history2 = await request({
    method: "GET",
    path: `/api/events/history?channel=history-channel&afterId=${afterId}&limit=5`,
  });
  assert(history2.statusCode === 200, `history page2 expected 200, got ${history2.statusCode}`);
  assert(Array.isArray(history2.json.events) && history2.json.events.length === 5, "history page2 size mismatch");

  const unauthorizedStream = await request({
    method: "GET",
    path: "/api/events/stream?userId=1&channels=channel-b",
  });
  assert(unauthorizedStream.statusCode === 403, `unauthorized stream expected 403, got ${unauthorizedStream.statusCode}`);

  const filterStream = openSse({ path: "/api/events/stream?userId=1&channels=channel-a" });
  await filterStream.ready;

  await request({
    method: "POST",
    path: "/api/events/publish",
    body: { channel: "channel-b", eventType: "FILTER_TEST", payload: { marker: "wrong-channel" } },
  });

  await sleep(1000);
  assert(filterStream.messages.length === 0, "received event from unsubscribed channel");

  await request({
    method: "POST",
    path: "/api/events/publish",
    body: { channel: "channel-a", eventType: "FILTER_TEST", payload: { marker: "right-channel" } },
  });

  await waitForMessages(filterStream, 1, 5000);
  assert(filterStream.messages[0].payload.marker === "right-channel", "did not receive expected channel event");
  filterStream.close();

  const replayLive = openSse({ path: "/api/events/stream?userId=1&channels=replay-channel" });
  await replayLive.ready;

  for (let i = 1; i <= 3; i += 1) {
    await request({
      method: "POST",
      path: "/api/events/publish",
      body: {
        channel: "replay-channel",
        eventType: "REPLAY_TEST",
        payload: { seq: i },
      },
    });
  }

  await waitForMessages(replayLive, 3, 7000);
  const firstReplayId = replayLive.messages[0].id;
  const expectedReplayIds = replayLive.messages.slice(1).map((event) => event.id);
  replayLive.close();

  const replayCatchup = openSse({
    path: "/api/events/stream?userId=1&channels=replay-channel",
    headers: { "Last-Event-ID": String(firstReplayId) },
  });
  await replayCatchup.ready;
  await waitForMessages(replayCatchup, 2, 5000);
  const actualReplayIds = replayCatchup.messages.slice(0, 2).map((event) => event.id);
  replayCatchup.close();

  assert(
    actualReplayIds[0] === expectedReplayIds[0] && actualReplayIds[1] === expectedReplayIds[1],
    `replay mismatch. expected ${expectedReplayIds.join(",")}, got ${actualReplayIds.join(",")}`
  );

  const heartbeatStream = openSse({ path: "/api/events/stream?userId=1&channels=test-stream-channel" });
  await heartbeatStream.ready;
  await sleep(35000);
  heartbeatStream.close();
  assert(
    heartbeatStream.comments.some((line) => line.includes("heartbeat")),
    "did not receive heartbeat comment within 35 seconds"
  );

  const active = await request({ method: "GET", path: "/api/events/active-connections" });
  assert(active.statusCode === 200, `active-connections expected 200, got ${active.statusCode}`);

  console.log("All contract checks passed.");
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("Contract checks failed:", error.message);
    process.exit(1);
  });
