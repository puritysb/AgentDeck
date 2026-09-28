#!/bin/bash
# Capture the README / project-site screenshots from the deterministic demo feed.
#
#   bash scripts/capture-marketing-screenshots.sh
#
# This is NOT the App Store path. `capture-appstore-screenshots.sh` and
# `record-appstore-previews.sh` deliberately run the feed without
# `--relay-usage`, because the sandboxed App Store build cannot produce Claude's
# subscription gauges on its own and a store asset must not advertise them. The
# README, the project site and the plugin marketplaces describe the daemon
# product, where a Node daemon relays that quota and the gauges are real — so
# these captures opt in, and they are written to `docs/media/`, never to
# `apple/appstore-submission/`.
#
# The other reason this exists: the screenshots it replaces were real captures
# of this desk, carrying real project names and non-English task text into an
# English-language README. Everything here comes from the same synthetic feed
# the previews use.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

PORT="${AGENTDECK_DEMO_PORT:-9220}"
WS="ws://127.0.0.1:$PORT"
LEAD_SECONDS=12
OUT="$ROOT/docs/media"
MACOS_APP="$ROOT/apple/DerivedData/Build/Products/Debug/AgentDeck.app"
BUNDLE_ID="bound.serendipity.agent.deck"

# Same density rule as the App Store path: a 1440x900 logical window on a 2x
# display is 2880x1800 of real pixels. Docs get a 2560-wide downscale.
MAC_WIN_W=1440; MAC_WIN_H=900
MAC_WIN_X=${AGENTDECK_CAPTURE_WIN_X:-0}; MAC_WIN_Y=${AGENTDECK_CAPTURE_WIN_Y:-30}
MAC_CROP_X=${AGENTDECK_CAPTURE_CROP_X:-$MAC_WIN_X}; MAC_CROP_Y=${AGENTDECK_CAPTURE_CROP_Y:-$MAC_WIN_Y}
MAC_DISPLAY=${AGENTDECK_CAPTURE_DISPLAY:-1}
DOC_WIDTH=2560

# Beats chosen for what each image has to say, not for the cycle's drama:
# `21.5s` has five sessions live with the roster full and the rail populated,
# and it focuses demo-claude, which is the session the collaboration record
# below belongs to.
BEAT_TIME=21.5

command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }
[ -d "$MACOS_APP" ] || { echo "build the macOS Debug app first: xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -derivedDataPath apple/DerivedData build" >&2; exit 1; }
# Fail before quitting/relaunching anything if a TCC grant would stall the capture.
bash "$ROOT/scripts/macos-preflight.sh" --automation --accessibility --screen-recording || exit

now_ms() { python3 -c "import time;print(int(time.time()*1000))"; }

stop_feed() { bash "$ROOT/scripts/record-feature-demo.sh" stop >/dev/null 2>&1 || true; }

start_feed_at() {
  local epoch_ms="$1"
  stop_feed
  mkdir -p "${TMPDIR:-/tmp}/agentdeck-launch-demo"
  echo "$epoch_ms" > "${TMPDIR:-/tmp}/agentdeck-launch-demo/epoch-ms"
  node "$ROOT/scripts/appstore-demo-orchestrator.mjs" serve \
    --port "$PORT" --epoch-ms "$epoch_ms" --relay-usage \
    > "${TMPDIR:-/tmp}/agentdeck-launch-demo/server.log" 2>&1 &
  CAPTURE_FEED_PID=$!
  echo "$CAPTURE_FEED_PID" > "${TMPDIR:-/tmp}/agentdeck-launch-demo/server.pid"
  sleep 0.6
}

wait_for_beat() {
  local epoch_ms="$1" beat="$2"
  python3 -c "
import time
target = ($epoch_ms + $beat * 1000) / 1000
time.sleep(max(0, target - time.time()))
"
}

HIDDEN_APPS=""
CAPTURE_FEED_PID=""
cleanup_capture() {
  restore_hidden_apps
  if [ -n "$CAPTURE_FEED_PID" ]; then
    kill "$CAPTURE_FEED_PID" 2>/dev/null || true
    wait "$CAPTURE_FEED_PID" 2>/dev/null || true
  fi
}
trap cleanup_capture EXIT
isolate_dashboard() {
  HIDDEN_APPS="$(osascript -e 'tell application "System Events" to get name of (every process whose visible is true and background only is false and name is not "AgentDeck")' 2>/dev/null || true)"
  osascript -e 'tell application "System Events" to set visible of (every process whose name is not "AgentDeck" and background only is false) to false' >/dev/null 2>&1 || true
  osascript -e 'tell application "AgentDeck" to activate' >/dev/null 2>&1 || true
  sleep 1.5
}
restore_hidden_apps() {
  [ -n "$HIDDEN_APPS" ] || return 0
  local IFS=','
  for app in $HIDDEN_APPS; do
    app="$(echo "$app" | sed -e 's/^ *//' -e 's/ *$//')"
    [ -n "$app" ] || continue
    osascript -e "tell application \"System Events\" to set visible of process \"$app\" to true" >/dev/null 2>&1 || true
  done
  HIDDEN_APPS=""
}

force_window_geometry() {
  local want_w="$1" want_h="$2" want_x="$3" want_y="$4" got=""
  local attempt
  for attempt in 1 2 3 4 5 6 7 8; do
    osascript -e "tell application \"System Events\" to tell process \"AgentDeck\"
      set position of window 1 to {$want_x, $want_y}
      set size of window 1 to {$want_w, $want_h}
    end tell" >/dev/null 2>&1 || true
    sleep 0.7
    got="$(osascript -e 'tell application "System Events" to tell process "AgentDeck" to return size of window 1' 2>/dev/null | tr -d ' ')" || got=""
    if [ "$got" = "$want_w,$want_h" ]; then
      echo "window geometry ${want_w}x${want_h} @ ${want_x},${want_y} (attempt $attempt)"
      return 0
    fi
  done
  echo "window geometry never took: wanted ${want_w}x${want_h}, got ${got:-unknown}" >&2
  return 1
}

# `collaboration` is the one capture that needs the panel open; every other
# image wants the rail it would cover. The toggle is persisted, so it is set
# explicitly for each take rather than inherited.
capture() {
  local name="$1" collaboration="$2"

  osascript -e 'quit app "AgentDeck"' >/dev/null 2>&1 || true
  sleep 2

  local epoch; epoch=$(( $(now_ms) + (LEAD_SECONDS * 1000) ))
  start_feed_at "$epoch"

  open -n "$MACOS_APP" --args -AgentDeckScreenshotURL "$WS" -dashboardCollaborationEnabled "$collaboration" -AppleLanguages '("en")'
  sleep 6
  isolate_dashboard
  force_window_geometry "$MAC_WIN_W" "$MAC_WIN_H" "$MAC_WIN_X" "$MAC_WIN_Y"

  mkdir -p "$OUT"
  local tmp="${TMPDIR:-/tmp}/agentdeck-marketing-shot.png"
  wait_for_beat "$epoch" "$BEAT_TIME"
  screencapture -D"$MAC_DISPLAY" -x "$tmp"
  restore_hidden_apps
  ffmpeg -y -v error -i "$tmp" \
    -vf "crop=$((MAC_WIN_W*2)):$((MAC_WIN_H*2)):$((MAC_CROP_X*2)):$((MAC_CROP_Y*2)),scale=$DOC_WIDTH:-2:flags=lanczos" \
    -pix_fmt rgb24 "$OUT/$name.png"
  echo "captured docs/media/$name.png ($(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$OUT/$name.png"))"
}

capture macos-dashboard false
capture collaboration-panel true

stop_feed
osascript -e 'quit app "AgentDeck"' >/dev/null 2>&1 || true

echo
echo "These are marketing captures and carry Claude's relayed gauges on purpose."
echo "Never copy them into apple/appstore-submission/."
