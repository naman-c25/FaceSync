#!/usr/bin/env bash
#
# Start both services and tie their lifetimes together.
#
# A container whose main process is alive while a service inside it has died is
# worse than one that exited: the platform sees a healthy container and keeps
# routing traffic to something that cannot serve it. `wait -n` returns as soon
# as *either* job exits, so whichever one falls over takes the container with
# it and the platform restarts the lot.
set -euo pipefail

cleanup() {
  # Without this, a stop signal leaves the other service running until the
  # platform's grace period expires and it gets killed uncleanly.
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[start] python ml service on :${FACEPAY_PORT}"
(cd ml-service && exec python -m uvicorn app:app \
    --host 127.0.0.1 --port "${FACEPAY_PORT}" --log-level warning) &

# The Node layer answers /health by asking the ML service, so starting it
# before the models have loaded means the first health check reports a broken
# system. Models take 3-5 seconds; the ceiling is generous for slow cold disks.
echo "[start] waiting for models"
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${FACEPAY_PORT}/health" >/dev/null 2>&1; then
    echo "[start] models ready"
    break
  fi
  sleep 1
done

echo "[start] node api on :${PORT}"
(cd backend && exec node src/server.js) &

wait -n
echo "[start] a service exited — bringing the container down"
exit 1
