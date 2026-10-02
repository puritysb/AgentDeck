#!/bin/sh
# Master-camera comparison for the current blockout.   sh run_master.sh <dir>
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
B="$HERE/hermes-head-blockout.blend"
blender --background "$B" --python "$HERE/render_views.py" -- "$1/grey" 32 32 1 4 4 1 >/dev/null 2>&1
blender --background "$B" --python "$HERE/render_views.py" -- "$1/like" 32 32 1 4 4 1 --like >/dev/null 2>&1
blender --background "$B" --python "$HERE/render_views.py" -- "$1/studio" 32 32 1 4 4 1 --studio >/dev/null 2>&1
cd "$HERE" && /Applications/Blender.app/Contents/Resources/5.2/python/bin/python3.13 master_overlay.py "$1"
