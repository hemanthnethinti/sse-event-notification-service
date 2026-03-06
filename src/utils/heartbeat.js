const HEARTBEAT_INTERVAL_MS = 30 * 1000;

function startHeartbeat({ res, writeHeartbeat, onWriteFailure }) {
  const timer = setInterval(() => {
    const wroteHeartbeat = writeHeartbeat(res);
    if (!wroteHeartbeat) {
      onWriteFailure();
    }
  }, HEARTBEAT_INTERVAL_MS);

  return () => clearInterval(timer);
}

module.exports = {
  HEARTBEAT_INTERVAL_MS,
  startHeartbeat,
};
