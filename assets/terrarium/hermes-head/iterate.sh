#!/bin/sh
# One fix-verify iteration on the FINAL app model (not the grey blockout).
#   sh iterate.sh <dir>
# blockout -> fit render -> v19 build (preview, not installed) -> master-camera /
# front / profile look renders -> compare.png, plus RealityKit face/3-4/blink.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
D=$1; mkdir -p "$D"
PY=/Applications/Blender.app/Contents/Resources/5.2/python/bin/python3.13
sh "$HERE/run.sh" "$D/blockout" >/dev/null
blender --background "$HERE/hermes-head-blockout.blend" --python "$HERE/render_views.py" -- "$D/fit" 32 32 1 4 4 1 --like >/dev/null 2>&1
blender --background --python-exit-code 1 --python "$ROOT/assets/terrarium/build-hermes-mermaid.py" -- --preview-only --out "$D/build" 2>&1 | grep -E "Error|assert|Traceback" || true
blender --background "$D/build/hermes.blend" --python "$HERE/master_look.py" -- "$D/look" >/dev/null 2>&1
cd "$HERE" && $PY look_compare.py "$D/look" "$D/fit/y32_e4.png" >/dev/null
NP="$D/../native-preview"
[ "$NP" -nt "$HERE/native_preview.swift" ] || xcrun swiftc -parse-as-library "$HERE/native_preview.swift" -o "$NP"
for v in face tq master; do "$NP" "$D/build/hermes.usdz" "$D/look/rk-$v.png" open $v >/dev/null; done
"$NP" "$D/build/hermes.usdz" "$D/look/rk-blink.png" blink face >/dev/null
magick "$D/look/rk-face.png" "$D/look/rk-tq.png" "$D/look/rk-blink.png" -resize 600x600 +append "$D/look/rk.png"
magick "$HERE/ref/master-tq.png" -resize x600 "$D/look/rk-master.png" -resize x600 +append "$D/look/rk-vs-master.png"
echo "$D/look/compare.png $D/look/rk.png"
