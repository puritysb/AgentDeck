#!/bin/sh
# Laptop-lid sticker: the canonical Nous girl mark (design/brand/hermes.svg,
# used as-is, never redrawn) in --ink-900 on a --tide-50 rounded square: the mark
# fills the portrait's black areas, so light-on-dark read as a negative.
#   sh make_laptop_sticker.sh   -> laptop_sticker.png (1024 px)
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
TMP=$(mktemp -d)
sed 's/fill="currentColor"/fill="#0e1f1f"/; s/height="1em"/height="1024"/; s/width="1em"/width="1024"/' \
  "$ROOT/design/brand/hermes.svg" > "$TMP/mark.svg"
magick -background none -density 300 "$TMP/mark.svg" -resize 860x860 "$TMP/mark.png"
magick -size 1024x1024 xc:none -fill '#f5f3ec' -draw 'roundrectangle 0,0 1023,1023 130,130' \
  "$TMP/mark.png" -gravity center -composite "$HERE/laptop_sticker.png"
rm -rf "$TMP"
echo "$HERE/laptop_sticker.png"
