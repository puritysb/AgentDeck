#!/bin/sh
# Unified local test report — now a thin alias for the pre-release verification
# tier (scripts/verify.mjs), which runs every suite this host has a toolchain
# for, records skips with their reason, and renders the Build Health page to
# coverage/test-report/index.html.
#
# The previous implementation needed bash 4 associative arrays and failed on
# its first line under macOS's /bin/bash 3.2, so the documented command never
# ran on the maintainer's Mac. Flags are kept for existing muscle memory:
#
#   bash scripts/test-report.sh              # pnpm verify:full (+ report)
#   bash scripts/test-report.sh --report     # re-render from existing results
#   bash scripts/test-report.sh --vitest     # Vitest + coverage only
#   bash scripts/test-report.sh --android    # Android JUnit only
#   bash scripts/test-report.sh --apple      # Apple XCTest only
#   bash scripts/test-report.sh --robot      # ESP32 Robot: hardware, see esp32/robot/run.sh
set -eu
cd "$(dirname "$0")/.."

case "${1:---all}" in
  --all) exec node scripts/verify.mjs --tier full --report ;;
  --report) exec python3 scripts/generate-html-report.py ;;
  --vitest) exec node scripts/verify.mjs --tier full --only vitest-coverage --report ;;
  --android) exec node scripts/verify.mjs --tier full --only android --report ;;
  --apple) exec node scripts/verify.mjs --tier full --only apple-macos --report ;;
  --robot)
    echo "The Robot suites need boards on USB: run bash esp32/robot/run.sh hw|protocol|perf," >&2
    echo "then record the outcome with pnpm verify:full --attest esp32-robot=pass|fail[:note]." >&2
    exit 2 ;;
  *) echo "usage: $0 [--all|--report|--vitest|--android|--apple|--robot]" >&2; exit 2 ;;
esac
