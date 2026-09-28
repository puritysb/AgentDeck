#!/bin/bash
# Capture App Store App Previews from the deterministic demo feed.
#
#   bash scripts/record-appstore-previews.sh macos
#   bash scripts/record-appstore-previews.sh iphone
#   bash scripts/record-appstore-previews.sh ipad
#
# Each run starts the demo feed with an epoch a few seconds in the FUTURE and
# launches the app fresh against it, so the recording opens on a genuinely
# empty dashboard. Recording an already-looping feed does not work: the
# previous cycle's last session card survives the empty phase and the cold
# open reads as "one idle session" instead of "nothing running yet".
#
# Output lands in apple/appstore-submission/previews/<platform>/ already
# encoded to the dimensions, duration, codec and bitrate that
# apple/scripts/validate-appstore-submission.sh enforces.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

PLATFORM="${1:-}"
PORT="${AGENTDECK_DEMO_PORT:-9220}"
WS="ws://127.0.0.1:$PORT"
CLIP_SECONDS=28          # App Previews must be 15–30s
LEAD_SECONDS=12          # app connects and settles before the cycle starts
RAW_SECONDS=$(( CLIP_SECONDS + LEAD_SECONDS + 8 ))
WORK="${TMPDIR:-/tmp}/agentdeck-appstore-previews"
MACOS_APP="$ROOT/apple/DerivedData/Build/Products/Debug/AgentDeck.app"
IOS_APP="$ROOT/apple/DerivedData/Build/Products/Debug-iphonesimulator/AgentDeck.app"
BUNDLE_ID="bound.serendipity.agent.deck"

# macOS window geometry: 16:9 in logical points, doubled on a 2x display.
# Height is bounded by the menu bar and Dock, so this is the largest 16:9
# window that fits without the Dock clipping it.
MAC_WIN_W=1856; MAC_WIN_H=1044; MAC_WIN_X=${AGENTDECK_CAPTURE_WIN_X:-0}; MAC_WIN_Y=${AGENTDECK_CAPTURE_WIN_Y:-30}
# Display and window origin are overridable: `screencapture -D` indexes the
# displays and the window origin is a GLOBAL coordinate, so on a multi-display
# desk the dashboard can be recorded on whichever screen is free of other
# windows. Defaults keep the single-display behaviour.
MAC_DISPLAY=${AGENTDECK_CAPTURE_DISPLAY:-1}
# The window POSITION is global across all displays; the crop offset is
# display-local. They coincide only on the display whose origin is (0,0), so a
# capture on a secondary screen needs both.
MAC_CROP_X=${AGENTDECK_CAPTURE_CROP_X:-$MAC_WIN_X}; MAC_CROP_Y=${AGENTDECK_CAPTURE_CROP_Y:-$MAC_WIN_Y}


usage() { echo "Usage: bash scripts/record-appstore-previews.sh {macos|iphone|ipad}" >&2; exit 2; }
[[ "$PLATFORM" =~ ^(macos|iphone|ipad)$ ]] || usage
command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }

mkdir -p "$WORK"
RAW="$WORK/$PLATFORM-raw.mov"
rm -f "$RAW"

stop_feed() { bash "$ROOT/scripts/record-feature-demo.sh" stop >/dev/null 2>&1 || true; }

# Start the feed with a future epoch and report it (ms since epoch).
start_feed_at() {
  local epoch_ms="$1"
  stop_feed
  mkdir -p "${TMPDIR:-/tmp}/agentdeck-launch-demo"
  echo "$epoch_ms" > "${TMPDIR:-/tmp}/agentdeck-launch-demo/epoch-ms"
  node "$ROOT/scripts/appstore-demo-orchestrator.mjs" serve \
    --port "$PORT" --epoch-ms "$epoch_ms" \
    > "${TMPDIR:-/tmp}/agentdeck-launch-demo/server.log" 2>&1 &
  CAPTURE_FEED_PID=$!
  echo "$CAPTURE_FEED_PID" > "${TMPDIR:-/tmp}/agentdeck-launch-demo/server.pid"
  sleep 0.6
}

now_ms() { python3 -c "import time;print(int(time.time()*1000))"; }

# ---------------------------------------------------------------- encode
# `offset` is where the cycle actually begins inside the raw file.
encode() {
  local raw="$1" offset="$2" filter="$3" out="$4"
  mkdir -p "$(dirname "$out")"
  # App Store Connect rejects App Previews with no audio stream at all
  # ("unsupported or corrupted audio") — a silent AAC-LC track is required
  # even though the captures themselves are silent. Do not reintroduce `-an`.
  ffmpeg -y -v error -accurate_seek -ss "$offset" -t "$CLIP_SECONDS" -i "$raw" \
    -f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=44100" \
    -vf "$filter,format=yuv420p" -r 30 \
    -c:v libx264 -profile:v high -level:v 4.0 \
    -b:v 11M -maxrate 11M -bufsize 22M \
    -c:a aac -b:a 128k -ar 44100 -ac 2 \
    -map 0:v:0 -map 1:a:0 -shortest \
    -movflags +faststart "$out"
  echo "wrote $out"
  ffprobe -v error -select_streams v:0 \
    -show_entries stream=width,height,r_frame_rate,profile,level \
    -show_entries format=duration,bit_rate -of default=nw=1 "$out"
  ffprobe -v error -select_streams a:0 \
    -show_entries stream=codec_name,sample_rate,channels -of default=nw=1 "$out"
}

# ---------------------------------------------------------------- macOS
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

record_macos() {
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

  local t0; t0=$(now_ms)
  screencapture -v -D"$MAC_DISPLAY" -V "$RAW_SECONDS" "$RAW" &
  local pid=$!
  echo "recording macOS · cycle starts $(( epoch - t0 ))ms into the run"
  wait $pid
  restore_hidden_apps

  # screencapture drops ~0.9s of frames while it spins up; measure_offset
  # below is refined by inspecting the first frame.
  local offset; offset=$(python3 -c "print(max(0,($epoch-$t0)/1000-0.9))")
  echo "$offset" > "$WORK/macos-offset"

  # `screencapture -V` does NOT record at the backing resolution. On this desk a
  # 5120x2880 panel whose still grabs come out at 5120x2880 records video at
  # 4096x2304, so the window-to-frame ratio is 1.6, not the 2 a Retina display
  # implies — and a hardcoded doubling framed 80% dashboard, 20% wallpaper while
  # every geometry check passed. Derive the crop from what the recorder actually
  # produced against the display's LOGICAL size, and round to even numbers for
  # yuv420p.
  local raw_w raw_h logical_w logical_h crop
  raw_w="$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$RAW")"
  raw_h="$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$RAW")"
  logical_w="$(osascript -e 'tell application "Finder" to get item 3 of (get bounds of window of desktop)' 2>/dev/null)"
  logical_h="$(osascript -e 'tell application "Finder" to get item 4 of (get bounds of window of desktop)' 2>/dev/null)"
  crop="$(python3 -c "
raw_w, raw_h = $raw_w, $raw_h
lw, lh = $logical_w, $logical_h
sx, sy = raw_w / lw, raw_h / lh
size = lambda v: max(2, int(round(v)) & ~1)
off = lambda v: max(0, int(round(v)) & ~1)
print('crop=%d:%d:%d:%d' % (size($MAC_WIN_W*sx), size($MAC_WIN_H*sy), off($MAC_CROP_X*sx), off($MAC_CROP_Y*sy)))
")"
  echo "raw ${raw_w}x${raw_h} · logical ${logical_w}x${logical_h} · $crop"
  encode "$RAW" "$offset" \
    "$crop,scale=1920:1080:flags=lanczos" \
    "$ROOT/apple/appstore-submission/previews/macOS/agentdeck-preview.mp4"
}

# ---------------------------------------------------------------- iOS
record_ios() {
  local device="$1" outdir="$2" scale="$3"
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

  local epoch; epoch=$(( $(now_ms) + (LEAD_SECONDS * 1000) ))
  start_feed_at "$epoch"

  xcrun simctl launch "$udid" "$BUNDLE_ID" -AgentDeckScreenshotURL "$WS" >/dev/null

  local t0; t0=$(now_ms)
  xcrun simctl io "$udid" recordVideo --codec h264 --force "$RAW" &
  local pid=$!
  echo "recording $device · cycle starts $(( epoch - t0 ))ms into the run"
  sleep "$RAW_SECONDS"
  kill -INT $pid 2>/dev/null || true
  wait $pid 2>/dev/null || true
  sleep 1

  local offset; offset=$(python3 -c "print(max(0,($epoch-$t0)/1000-0.5))")
  echo "$offset" > "$WORK/$PLATFORM-offset"
  encode "$RAW" "$offset" "$scale" "$ROOT/apple/appstore-submission/previews/$outdir/agentdeck-preview.mp4"
}

case "$PLATFORM" in
  macos)  record_macos ;;
  iphone) record_ios "iPhone 16 Pro Max" "iPhone" "scale=886:1920:flags=lanczos" ;;
  ipad)   record_ios "iPad Pro 13-inch (M4)" "iPad" "scale=1200:1600:flags=lanczos" ;;
esac

echo
echo "Verify before uploading:"
echo "  bash apple/scripts/validate-appstore-submission.sh"
