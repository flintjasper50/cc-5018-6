#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .run/fixture.pid ] && kill -0 "$(cat .run/fixture.pid)" 2>/dev/null; then
  PID=$(cat .run/fixture.pid)
  kill -- -"$PID" 2>/dev/null || kill "$PID" 2>/dev/null || true
  rm -f .run/fixture.pid
  echo "fixture stopped"
else
  rm -f .run/fixture.pid
  echo "no fixture running"
fi
