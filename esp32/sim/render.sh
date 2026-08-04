#!/usr/bin/env bash
# Build + render AgentDeck ESP32 board screens on the host (no hardware).
#
# Usage:
#   ./render.sh                 # all boards, all scenes → sim-out/
#   ./render.sh box_86          # one board, all scenes
#   ./render.sh box_86 working  # one board, one scene
#
# Boards mirror esp32/sim/platformio.ini envs: box_86 (480x480), ips35 (480x320),
# amoled (360x360 round). Add more by copying an env block with the target board's
# BOARD_*/SCREEN_* defines.
set -euo pipefail
cd "$(dirname "$0")"

PIO="${PIO:-pio}"
command -v "$PIO" >/dev/null 2>&1 || PIO="$HOME/.platformio/penv/bin/pio"

# xteink_x3 / xteink_x4 are deliberately NOT in the default set: they render the
# AgentDeck e-ink tree at the community fork's panel sizes (a layout diagnostic
# for the shared geometry SSOT), and their output is not that fork's firmware
# output. Ask for them by name.
BOARDS_DEFAULT="box_86 ips35 amoled ttgo ips10 t_embed t_display_pro led8x32 inkdeck"
BOARD="${1:-}"
SCENE="${2:-}"
OUTDIR="${OUTDIR:-sim-out}"
mkdir -p "$OUTDIR"

boards="${BOARD:-$BOARDS_DEFAULT}"
for b in $boards; do
  echo "==> building $b"
  "$PIO" run -e "$b" >/dev/null
  bin=".pio/build/$b/program"
  if [ -n "$SCENE" ]; then
    "$bin" --label "$b" --scene "$SCENE" --out "$OUTDIR/$b-$SCENE.png"
  else
    "$bin" --label "$b" --all --outdir "$OUTDIR"
  fi
done
echo "==> wrote PNGs to $OUTDIR/"
ls -1 "$OUTDIR"/*.png
