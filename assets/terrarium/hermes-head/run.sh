#!/bin/sh
# seed -> edits -> fringe hem -> locks -> headset -> review renders -> comparison sheet.   sh run.sh <render_dir>
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
B="$HERE/hermes-head-blockout.blend"
blender --background --python-exit-code 1 --python "$HERE/bootstrap_blockout.py" -- "$B" 2>&1 | grep -E "seeded|rror" || true
blender --background "$B" --python-exit-code 1 --python "$HERE/apply_edits.py" -- "$B" 2>&1 | grep -E "applied|rror" || true
blender --background "$B" --python-exit-code 1 --python "$HERE/refine_fringe.py" -- "$B" 2>&1 | grep -E "^fringe|rror" || true
blender --background "$B" --python-exit-code 1 --python "$HERE/build_locks.py" -- "$B" 2>&1 | grep -E "^locks|rror" || true
# (build_lock_planes.py is not run: its flat roof strips read as stepped blocks
#  and jagged seams next to the master; the faceted cage reads as the bob.)
blender --background "$B" --python-exit-code 1 --python "$HERE/build_headset.py" -- "$B" 2>&1 | grep -E "^headset|rror" || true
blender --background "$B" --python-exit-code 1 --python "$HERE/review_blockout.py" -- "$1" 2>&1 | grep -E "rror" || true
sh "$HERE/compare.sh" "$1"
