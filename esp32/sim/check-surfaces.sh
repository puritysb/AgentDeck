#!/usr/bin/env bash
# Run already-built real render trees. No hardware, daemon or network I/O.
set -euo pipefail
cd "$(dirname "$0")"
audit_out=${1:-sim-out/verification}
for board in box_86 ips35 amoled ttgo; do
  mkdir -p "$audit_out/$board"
  ".pio/build/$board/program" --verify-habitat --page terrarium --outdir "$audit_out/$board"
done
for board in ips10 t_embed t_display_pro; do
  mkdir -p "$audit_out/$board"
  ".pio/build/$board/program" --verify-interactions --outdir "$audit_out/$board"
done
