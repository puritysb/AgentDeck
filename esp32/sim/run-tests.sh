#!/usr/bin/env bash
# Host unit tests for the e-ink geometry + page-policy SSOT headers. These are
# plain assert() mains with no framework and no board: they compile the same
# headers the firmware compiles. Kept out of PlatformIO on purpose — they need
# no toolchain beyond the host compiler.
set -euo pipefail
cd "$(dirname "$0")"
CXX=${CXX:-c++}
mkdir -p .pio/test
fail=0
for t in tests/*_test.cpp; do
  name=$(basename "$t" .cpp)
  "$CXX" -std=c++17 -I ../src -I .. -I shims -o ".pio/test/$name" "$t"
  if ".pio/test/$name"; then echo "  ok   $name"; else echo "  FAIL $name"; fail=1; fi
done
exit $fail
