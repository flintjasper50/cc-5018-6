#!/bin/bash
# Put the self-made fixture on the X display as a kiosk window, detached from
# the calling shell. The experiment driver captures this screen, so the fixture
# must be the top-most, full-screen surface and must keep painting even while
# no browser window has focus.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .run
DISPLAY_NUM="${FIXTURE_DISPLAY:-:99}"
W="${FIXTURE_W:-1920}"
H="${FIXTURE_H:-1080}"
MODE="${FIXTURE_MODE:-mixed}"
CHART_HZ="${FIXTURE_CHART_HZ:-12}"

if [ -f .run/fixture.pid ] && kill -0 "$(cat .run/fixture.pid)" 2>/dev/null; then
  echo "fixture already running pid $(cat .run/fixture.pid)"
  exit 0
fi

CHROME="${CHROME_BIN:-/home/node/.cache/ms-playwright/chromium-1255/chrome-linux-arm64/chrome}"
if [ ! -x "$CHROME" ]; then
  echo "chrome not found at $CHROME; set CHROME_BIN" >&2
  exit 1
fi
LIBDIR="${CHROME_LIBS:-/tmp/rootfs/usr/lib/aarch64-linux-gnu:/tmp/rootfs/lib/aarch64-linux-gnu}"
PORT="${FIXTURE_CDP_PORT:-9555}"
PROFILE="${FIXTURE_PROFILE:-/tmp/fixture-profile}"

# Chrome shows an "offer to translate" bubble for the zh-CN fixture page. It is
# browser-level UI (not page DOM), so it also lands in the screen capture.
# Seed the profile preferences to keep it from ever opening.
mkdir -p "$PROFILE/Default"
if [ ! -f "$PROFILE/Default/Preferences" ]; then
  cat > "$PROFILE/Default/Preferences" <<'PREFS'
{"translate":{"enabled":false},"translate_ignored_languages":["zh","zh-CN"],
 "profile":{"default_content_setting_values":{}},
 "intl":{"accept_languages":"zh-CN,zh,en-US,en"}}
PREFS
fi

setsid nohup env DISPLAY="$DISPLAY_NUM" LD_LIBRARY_PATH="$LIBDIR" \
  "$CHROME" \
  --no-sandbox --disable-gpu \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port="$PORT" \
  --hide-scrollbars \
  --test-type --no-first-run --no-default-browser-check --lang=zh-CN \
  --disable-translate \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding \
  --disable-backgrounding-occluded-windows \
  --disable-features=CalculateNativeWinOcclusion,Translate,TranslateUI \
  --kiosk --window-position=0,-${INFOBAR_H:-36} --window-size="$W,$((H + ${INFOBAR_H:-36}))" \
  --app="http://127.0.0.1:8080/fixture.html?mode=$MODE&chartHz=$CHART_HZ" \
  >.run/fixture.log 2>&1 < /dev/null &
echo $! > .run/fixture.pid

for _ in $(seq 1 40); do
  if curl -sf -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    echo "fixture up pid $(cat .run/fixture.pid) cdp $PORT"
    exit 0
  fi
  sleep 0.25
done
echo "fixture failed to start; log:" >&2
tail -20 .run/fixture.log >&2
exit 1
