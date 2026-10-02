#!/bin/sh
# Build the review sheet: reference | grey model | overlay (model 50% + outline),
# for front and profile, plus master three-quarter vs model three-quarter.
#   sh compare.sh <render_dir>
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
D=$1
for v in front profile; do
  magick "$D/$v.png" -alpha extract -morphology EdgeOut Diamond:2 -background none \
    -fill '#ff5a36' -opaque white -transparent black "$D/$v-edge.png"
  magick "$HERE/ref/$v.png" \( "$D/$v.png" -channel A -evaluate multiply 0.5 +channel \) -composite \
    "$D/$v-edge.png" -composite "$D/$v-overlay.png"
  magick "$D/$v.png" -background '#23404a' -flatten "$D/$v-grey.png"
  magick "$D/$v-grey.png" "$HERE/ref/$v-lines.png" -composite "$D/$v-lines.png"
  magick "$HERE/ref/$v.png" "$D/$v-grey.png" "$D/$v-lines.png" +append "$D/$v-row.png"
done
magick "$D/three-quarter.png" -background '#23404a' -flatten -resize 600x545 "$D/tq-grey.png"
magick "$HERE/ref/tq-master.png" -resize 600x503 -background '#0b2b3f' -gravity center -extent 600x545 "$D/tq-ref.png"
magick "$D/tq-ref.png" "$D/tq-grey.png" +append -background '#23404a' -gravity west -extent 1980x545 "$D/tq-row.png"
magick "$D/front-row.png" "$D/profile-row.png" "$D/tq-row.png" -append "$D/sheet.png"
echo "$D/sheet.png"
