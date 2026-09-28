#!/bin/bash
# Capture App Store screenshots from the same deterministic demo feed that
# produces the App Previews, so the still and motion assets tell one story and
# neither exposes a real workspace.
#
#   bash scripts/capture-appstore-screenshots.sh macos
#   bash scripts/capture-appstore-screenshots.sh iphone
#   bash scripts/capture-appstore-screenshots.sh ipad
#
# Four beats are captured per platform, at fixed offsets into the 30s cycle:
#   1. fleet    — several agents working at once, quota gauge live
#   2. all-sessions — nothing focused, so every agent's events interleave in
#                 one timeline (the view keys off a missing focusedSessionId)
#   3. attention— the amber "a human is needed" moment
#   4. complete — every session resolved, terrarium at rest
#
# Native capture sizes are already App Store-legal, so nothing is rescaled:
#   iPhone 14 Plus 1284x2778 · iPad Pro 13" 2064x2752 · macOS 2880x1800
#   (a 1440x900 logical window on a 2x display).
#
# iPhone was "iPhone 16 Pro Max" (1320x2868) until 2026-07-19: ASC rejected
# that size for this app's screenshot slot with "unsupported screenshot
# size" (accepts only 1242x2688 or 1284x2778 — the "6.5-inch Display"
# bucket). Do not switch back to a 6.9"-class simulator without confirming
# ASC now accepts that bucket for this app record.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

PLATFORM="${1:-}"
PORT="${AGENTDECK_DEMO_PORT:-9220}"
WS="ws://127.0.0.1:$PORT"
LEAD_SECONDS=12
SHOTS="$ROOT/apple/appstore-submission/screenshots-raw"
MACOS_APP="$ROOT/apple/DerivedData/Build/Products/Debug/AgentDeck.app"
IOS_APP="$ROOT/apple/DerivedData/Build/Products/Debug-iphonesimulator/AgentDeck.app"
BUNDLE_ID="bound.serendipity.agent.deck"

# Cycle offsets, in seconds, for the three beats.
BEAT_TIMES=(9.5 14.5 18.8 27.5)
BEAT_NAMES=(01-fleet 02-all-sessions 03-attention 04-complete)

# 16:10 window so the macOS capture is exactly 2880x1800 physical.
MAC_WIN_W=1440; MAC_WIN_H=900; MAC_WIN_X=${AGENTDECK_CAPTURE_WIN_X:-0}; MAC_WIN_Y=${AGENTDECK_CAPTURE_WIN_Y:-30}
# Display and window origin are overridable: `screencapture -D` indexes the
# displays and the window origin is a GLOBAL coordinate, so on a multi-display
# desk the dashboard can be recorded on whichever screen is free of other
# windows. Defaults keep the single-display behaviour.
MAC_DISPLAY=${AGENTDECK_CAPTURE_DISPLAY:-1}
# The window POSITION is global across all displays; the crop offset is
# display-local. They coincide only on the display whose origin is (0,0), so a
# capture on a secondary screen needs both.
MAC_CROP_X=${AGENTDECK_CAPTURE_CROP_X:-$MAC_WIN_X}; MAC_CROP_Y=${AGENTDECK_CAPTURE_CROP_Y:-$MAC_WIN_Y}


usage() { echo "Usage: bash scripts/capture-appstore-screenshots.sh {macos|iphone|ipad}" >&2; exit 2; }
[[ "$PLATFORM" =~ ^(macos|iphone|ipad)$ ]] || usage

now_ms() { python3 -c "import time;print(int(time.time()*1000))"; }

# App Store rejects screenshots carrying an alpha channel, and `simctl io
# screenshot` always writes RGBA. Flatten in place.
flatten() {
  local file="$1"
  ffmpeg -y -v error -i "$file" -pix_fmt rgb24 "${file%.png}.flat.png"
  mv "${file%.png}.flat.png" "$file"
}

start_feed_at() {
  local epoch_ms="$1"
  bash "$ROOT/scripts/record-feature-demo.sh" stop >/dev/null 2>&1 || true
  mkdir -p "${TMPDIR:-/tmp}/agentdeck-launch-demo"
  echo "$epoch_ms" > "${TMPDIR:-/tmp}/agentdeck-launch-demo/epoch-ms"
  node "$ROOT/scripts/appstore-demo-orchestrator.mjs" serve \
    --port "$PORT" --epoch-ms "$epoch_ms" \
    > "${TMPDIR:-/tmp}/agentdeck-launch-demo/server.log" 2>&1 &
  CAPTURE_FEED_PID=$!
  echo "$CAPTURE_FEED_PID" > "${TMPDIR:-/tmp}/agentdeck-launch-demo/server.pid"
  sleep 0.6
}

# Sleep until `epoch + offset`, where both are relative to the feed's cycle.
wait_for_beat() {
  local epoch_ms="$1" offset_s="$2"
  python3 - "$epoch_ms" "$offset_s" <<'PY'
import sys, time
target = int(sys.argv[1]) / 1000 + float(sys.argv[2])
delay = target - time.time()
if delay > 0:
    time.sleep(delay)
PY
}

# A capture must not inherit the operator's UI state or locale. The dashboard's
# Habitat/Collaboration toggle is persisted in the app's own defaults and the
# Debug build shares the shipping bundle id, so a panel left open on this desk
# lands in the submission assets — it happened, covering the topology rail that
# the `05-devices` crop is taken from. WeatherKit's attribution is localized
# too, so a Korean system produced a Korean word in an otherwise English
# capture, which is the opposite of the locale-independent raw capture this
# harness promises.

# `screencapture -D` records the display as composited, so ANY window above the
# dashboard lands inside the crop rect — a floating window from another app put
# a third party's UI (in another language) into a submission asset. Geometry was
# never the problem; z-order was. Hide every other regular app for the duration
# and put them back afterwards.
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

# Setting the geometry once is not enough: the window is restored to its
# remembered size after launch, so an early `set size` is silently reverted and
# the fixed crop rect then frames desktop instead of dashboard. Set it, read it
# back, and keep trying — a capture whose frame does not match the crop is worse
# than a failed run, so this reports rather than proceeding blind.
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

capture_macos() {
  # Fail before quitting/relaunching anything if a TCC grant would stall the capture.
  bash "$ROOT/scripts/macos-preflight.sh" --automation --accessibility --screen-recording || exit
  osascript -e 'quit app "AgentDeck"' >/dev/null 2>&1 || true
  sleep 2
  local epoch; epoch=$(( $(now_ms) + (LEAD_SECONDS * 1000) ))
  start_feed_at "$epoch"

  open -n "$MACOS_APP" --args -AgentDeckScreenshotURL "$WS" -dashboardCollaborationEnabled NO -AppleLanguages '("en")'
  sleep 6

  isolate_dashboard
  force_window_geometry "$MAC_WIN_W" "$MAC_WIN_H" "$MAC_WIN_X" "$MAC_WIN_Y"

  mkdir -p "$SHOTS/macOS"
  local tmp="${TMPDIR:-/tmp}/agentdeck-shot.png"
  for i in "${!BEAT_TIMES[@]}"; do
    wait_for_beat "$epoch" "${BEAT_TIMES[$i]}"
    screencapture -D"$MAC_DISPLAY" -x "$tmp"
    # Crop the window out of the full-display grab, in physical pixels.
    ffmpeg -y -v error -i "$tmp" \
      -vf "crop=$((MAC_WIN_W*2)):$((MAC_WIN_H*2)):$((MAC_CROP_X*2)):$((MAC_CROP_Y*2))" \
      -pix_fmt rgb24 "$SHOTS/macOS/${BEAT_NAMES[$i]}.png"
    flatten "$SHOTS/macOS/${BEAT_NAMES[$i]}.png"
    echo "captured macOS/${BEAT_NAMES[$i]}.png"
  done
  restore_hidden_apps
  rm -f "$tmp"
}

capture_ios() {
  local device="$1" outdir="$2"
  local udid
  udid="${AGENTDECK_CAPTURE_IOS_UDID:-}"
  if [ -z "$udid" ]; then
  udid="$(xcrun simctl list devices available | grep -F "$device (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')"
  fi
  [[ -n "$udid" ]] || { echo "simulator not found: $device" >&2; exit 1; }

  xcrun simctl boot "$udid" 2>/dev/null || true
  sleep 6
  xcrun simctl install "$udid" "$IOS_APP"
  xcrun simctl terminate "$udid" "$BUNDLE_ID" 2>/dev/null || true
  # Apple's canonical marketing status bar.
  xcrun simctl status_bar "$udid" override \
    --time "9:41" --cellularMode active --cellularBars 4 --wifiBars 3 --batteryState charged --batteryLevel 100 \
    >/dev/null 2>&1 || true

  local epoch; epoch=$(( $(now_ms) + (LEAD_SECONDS * 1000) ))
  start_feed_at "$epoch"
  xcrun simctl launch "$udid" "$BUNDLE_ID" -AgentDeckScreenshotURL "$WS" >/dev/null

  mkdir -p "$SHOTS/$outdir"
  for i in "${!BEAT_TIMES[@]}"; do
    wait_for_beat "$epoch" "${BEAT_TIMES[$i]}"
    xcrun simctl io "$udid" screenshot "$SHOTS/$outdir/${BEAT_NAMES[$i]}.png" >/dev/null 2>&1
    flatten "$SHOTS/$outdir/${BEAT_NAMES[$i]}.png"
    echo "captured $outdir/${BEAT_NAMES[$i]}.png"
  done
}

case "$PLATFORM" in
  macos)  capture_macos ;;
  iphone) capture_ios "iPhone 14 Plus" "iPhone" ;;
  ipad)   capture_ios "iPad Pro 13-inch (M4)" "iPad" ;;
esac

echo
echo "Verify before uploading:"
echo "  bash apple/scripts/validate-appstore-submission.sh"
