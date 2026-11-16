#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .run/server.pid ]; then
  kill "$(cat .run/server.pid)" 2>/dev/null || true
  rm -f .run/server.pid
  echo stopped
else
  pkill -f 'node server/main.mjs' 2>/dev/null || true
  echo "no pid file; pkill attempted"
fi
