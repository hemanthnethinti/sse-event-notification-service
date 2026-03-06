CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name VARCHAR(255) NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  channel VARCHAR(255) NOT NULL,
  event_type VARCHAR(255) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_channel_id ON events (channel, id);

CREATE TABLE IF NOT EXISTS user_subscriptions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, channel)
);

INSERT INTO users (id, name)
VALUES
  (1, 'netinti-hemanth-user1'),
  (2, 'netinti-hemanth-user2')
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_subscriptions (user_id, channel)
VALUES
  (1, 'alerts'),
  (1, 'test-channel'),
  (1, 'test-stream-channel'),
  (1, 'channel-a'),
  (1, 'history-channel'),
  (1, 'replay-channel'),
  (2, 'finance'),
  (2, 'channel-b'),
  (2, 'replay-channel')
ON CONFLICT (user_id, channel) DO NOTHING;

INSERT INTO events (channel, event_type, payload)
VALUES
  ('history-channel', 'HISTORY_SEEDED', '{"sequence": 1, "message": "seed history event 1"}'),
  ('history-channel', 'HISTORY_SEEDED', '{"sequence": 2, "message": "seed history event 2"}'),
  ('history-channel', 'HISTORY_SEEDED', '{"sequence": 3, "message": "seed history event 3"}'),
  ('history-channel', 'HISTORY_SEEDED', '{"sequence": 4, "message": "seed history event 4"}'),
  ('history-channel', 'HISTORY_SEEDED', '{"sequence": 5, "message": "seed history event 5"}'),
  ('history-channel', 'HISTORY_SEEDED', '{"sequence": 6, "message": "seed history event 6"}'),
  ('history-channel', 'HISTORY_SEEDED', '{"sequence": 7, "message": "seed history event 7"}'),
  ('history-channel', 'HISTORY_SEEDED', '{"sequence": 8, "message": "seed history event 8"}'),
  ('history-channel', 'HISTORY_SEEDED', '{"sequence": 9, "message": "seed history event 9"}'),
  ('history-channel', 'HISTORY_SEEDED', '{"sequence": 10, "message": "seed history event 10"}'),
  ('alerts', 'SYSTEM_ALERT', '{"message": "seed alert for user 1"}'),
  ('channel-b', 'SYSTEM_ALERT', '{"message": "seed alert for user 2"}');
