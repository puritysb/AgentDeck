#!/bin/bash
# Capture the docs images that only a REAL daemon can produce.
#
#   bash scripts/capture-live-screenshots.sh <window-title> <output-name>
#   bash scripts/capture-live-screenshots.sh 'APME Dashboard' apme-work
#
# Most of `docs/media/` comes from `capture-marketing-screenshots.sh`, which
# runs the deterministic demo feed and therefore shows no real project. Two
# surfaces cannot: the APME boards and the menu bar popup's activity summary
# read a much wider HTTP API than the demo orchestrator stubs, so they only
# have anything to show against a daemon that has actually been measuring work.
# Those captures are real by necessity — real task titles, real project names,
# whatever language the operator writes in. That is an accepted trade for these
# images; it is NOT acceptable for the App Store assets, which stay synthetic.
#
# What this script is really for is the part that has nothing to do with the
# data: framing. These images used to be full-screen 5K grabs of a 5120-wide
# desktop, which put the UI at a third of the density a reader needs and framed
# the Dock. The rule is the same one the App Store path uses — a 1440x900
# logical window on a 2x display is 2880x1800 of real pixels — and it is the
# window that is captured, never the screen.
#
# Requires: AgentDeck running and connected to a daemon with APME history.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
OUT="$ROOT/docs/media"

WIN_W=1440; WIN_H=900
WIN_X=${AGENTDECK_CAPTURE_WIN_X:-0}; WIN_Y=${AGENTDECK_CAPTURE_WIN_Y:-30}
CROP_X=${AGENTDECK_CAPTURE_CROP_X:-$WIN_X}; CROP_Y=${AGENTDECK_CAPTURE_CROP_Y:-$WIN_Y}
DISPLAY_ID=${AGENTDECK_CAPTURE_DISPLAY:-1}
DOC_WIDTH=2560

command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }
bash "$ROOT/scripts/macos-preflight.sh" --automation --accessibility --screen-recording || exit
# Tell "not running" apart from "not allowed to look": a denied Automation
# grant (-1743) used to be reported as "AgentDeck is not running".
if ! probe_err="$(osascript -e 'tell application "System Events" to get name of process "AgentDeck"' 2>&1 >/dev/null)"; then
  case "$probe_err" in
    *-1743*) echo "Automation to System Events is denied for this terminal: System Settings › Privacy & Security › Automation" >&2 ;;
    *-1728*) echo "AgentDeck is not running" >&2 ;;
    *) echo "could not check whether AgentDeck is running: $probe_err" >&2 ;;
  esac
  exit 1
fi

HIDDEN_APPS=""
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

open_window() {
  local title="$1"
  osascript -e "tell application \"System Events\" to tell process \"AgentDeck\"
    click menu item \"$title\" of menu 1 of menu bar item \"Window\" of menu bar 1
  end tell" >/dev/null 2>&1 || true
  sleep 2.5
}

# Set, read back, retry: a window is restored to its remembered size shortly
# after it opens, so setting it once is silently reverted and the fixed crop
# then frames desktop instead of app.
force_window_geometry() {
  local title="$1" got=""
  local attempt
  for attempt in 1 2 3 4 5 6 7 8; do
    osascript -e "tell application \"System Events\" to tell process \"AgentDeck\" to tell (first window whose name is \"$title\")
      set position to {$WIN_X, $WIN_Y}
      set size to {$WIN_W, $WIN_H}
    end tell" >/dev/null 2>&1 || true
    sleep 0.7
    got="$(osascript -e "tell application \"System Events\" to tell process \"AgentDeck\" to tell (first window whose name is \"$title\") to return size" 2>/dev/null | tr -d ' ')" || got=""
    if [ "$got" = "$WIN_W,$WIN_H" ]; then
      echo "  $title geometry ${WIN_W}x${WIN_H} @ ${WIN_X},${WIN_Y} (attempt $attempt)"
      return 0
    fi
  done
  echo "$title geometry never took: wanted ${WIN_W}x${WIN_H}, got ${got:-unknown}" >&2
  return 1
}

shoot() {
  local name="$1"
  mkdir -p "$OUT"
  local tmp="${TMPDIR:-/tmp}/agentdeck-live-shot.png"
  screencapture -D"$DISPLAY_ID" -x "$tmp"
  ffmpeg -y -v error -i "$tmp" \
    -vf "crop=$((WIN_W*2)):$((WIN_H*2)):$((CROP_X*2)):$((CROP_Y*2)),scale=$DOC_WIDTH:-2:flags=lanczos" \
    -pix_fmt rgb24 "$OUT/$name.png"
  echo "captured docs/media/$name.png ($(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$OUT/$name.png"))"
}

TITLE="${1:-APME Dashboard}"
NAME="${2:-apme-work}"

isolate_dashboard
trap restore_hidden_apps EXIT

open_window "$TITLE"
force_window_geometry "$TITLE"
shoot "$NAME"

restore_hidden_apps
trap - EXIT
echo
echo "Captured whatever tab the window is showing: SwiftUI's tab bar does not"
echo "respond to a System Events synthetic click, so selecting the tab is the"
echo "operator's job and this script deliberately does not pretend otherwise."
echo "These are real captures: real projects, real task titles, the operator's"
echo "own language. Never copy them into apple/appstore-submission/."
