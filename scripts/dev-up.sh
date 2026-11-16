#!/bin/bash
# Start web+TURN in the background, detached from the calling shell. The PID is
# written so dev-down.sh can stop exactly this instance.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .run
if [ -f .run/server.pid ] && kill -0 "$(cat .run/server.pid)" 2>/dev/null; then
  echo "already running pid $(cat .run/server.pid)"
  exit 0
fi
setsid nohup node server/main.mjs >.run/server.log 2>&1 < /dev/null &
echo $! > .run/server.pid
sleep 2
if curl -sf -m 3 http://127.0.0.1:8080/api/health >/dev/null; then
  echo "up pid $(cat .run/server.pid)"
else
  echo "failed to start; log:"; tail -20 .run/server.log; exit 1
fi
