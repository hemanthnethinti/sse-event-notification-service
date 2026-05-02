const http = require('http');
const { URL } = require('url');

const HOST = process.env.HOST || 'localhost';
const PORT = process.env.PORT || 8080;
const BASE = `http://${HOST}:${PORT}`;

function postJson(path, body) {
  const data = JSON.stringify(body);
  const url = new URL(path, BASE);
  const options = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port,
    path: url.pathname + url.search,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    },
    timeout: 5000,
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getJson(path) {
  const url = new URL(path, BASE);
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
        } catch (err) {
          resolve({ statusCode: res.statusCode, body });
        }
      });
    }).on('error', reject);
  });
}

function openSse(path, timeoutMs = 10000) {
  const url = new URL(path, BASE);
  const options = {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname + url.search,
    headers: {
      Accept: 'text/event-stream',
    },
    timeout: timeoutMs,
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error('SSE stream responded with ' + res.statusCode));
        res.resume();
        return;
      }

      res.setEncoding('utf8');
      let buffer = '';

      const onData = (chunk) => {
        buffer += chunk;
        const parts = buffer.split('\n\n');
        while (parts.length > 1) {
          const rawEvent = parts.shift();
          const lines = rawEvent.split(/\r?\n/);
          const event = {};
          for (const line of lines) {
            if (line.startsWith('data:')) {
              event.data = (event.data || '') + line.slice(5).trim();
            } else if (line.startsWith('id:')) {
              event.id = line.slice(3).trim();
            } else if (line.startsWith('event:')) {
              event.event = line.slice(6).trim();
            }
          }

          if (event.data) {
            try {
              event.payload = JSON.parse(event.data);
            } catch (e) {
              event.payload = event.data;
            }
            cleanup();
            resolve(event);
            return;
          }
        }
        buffer = parts[0];
      };

      const onError = (err) => {
        cleanup();
        reject(err);
      };

      const onTimeout = () => {
        cleanup();
        reject(new Error('SSE stream timeout'));
      };

      function cleanup() {
        res.removeListener('data', onData);
        res.removeListener('error', onError);
        req.abort();
      }

      res.on('data', onData);
      res.on('error', onError);
      req.on('timeout', onTimeout);
    });

    req.on('error', reject);
    req.end();
  });
}

(async function main() {
  console.log('Running smoke test against', BASE);

  try {
    const health = await getJson('/health');
    console.log('Health:', health.statusCode, health.body);
  } catch (err) {
    console.error('Health check failed:', err.message);
    process.exit(2);
  }

  try {
    console.log('Ensuring subscription for user 1 -> test-stream-channel');
    const sub = await postJson('/api/events/channels/subscribe', { userId: 1, channel: 'test-stream-channel' });
    console.log('Subscribe response:', sub.statusCode);
  } catch (err) {
    console.error('Subscribe failed:', err.message);
    process.exit(2);
  }

  // Start stream then publish an event
  const ssePromise = openSse('/api/events/stream?userId=1&channels=test-stream-channel', 15000);

  // wait a short moment then publish
  setTimeout(async () => {
    try {
      console.log('Publishing test event');
      await postJson('/api/events/publish', { channel: 'test-stream-channel', eventType: 'SMOKE_TEST', payload: { message: 'hello-smoke' } });
    } catch (err) {
      console.error('Publish failed:', err.message);
    }
  }, 400);

  try {
    const event = await ssePromise;
    console.log('Received event:', event);
    console.log('Smoke test succeeded');
    process.exit(0);
  } catch (err) {
    console.error('Did not receive event:', err.message);
    process.exit(3);
  }
})();
