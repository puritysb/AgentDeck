#!/bin/bash
# Build-time only. The product links a static library and contains no helper.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CARGO="${CARGO:-$(command -v cargo || true)}"
if [ -z "$CARGO" ]; then
    for CANDIDATE in "$HOME/.cargo/bin/cargo" /opt/homebrew/bin/cargo /usr/local/bin/cargo; do
        if [ -x "$CANDIDATE" ]; then CARGO="$CANDIDATE"; break; fi
    done
fi
if [ -z "$CARGO" ]; then
    echo 'error: Rust cargo is required to build the Glance static library.' >&2
    exit 1
fi
CACHE="${GLANCE_CARGO_TARGET_DIR:-${DERIVED_FILE_DIR:-$ROOT/shared/glance-raster/target}/glance-rust}"
LIBS=()
for ARCH in ${ARCHS:-$(uname -m)}; do
    case "$ARCH" in
        arm64) TARGET=aarch64-apple-darwin ;;
        x86_64) TARGET=x86_64-apple-darwin ;;
        *) echo "error: unsupported Glance target architecture: $ARCH" >&2; exit 1 ;;
    esac
    "$CARGO" build --locked --release --manifest-path "$ROOT/shared/glance-raster/Cargo.toml" --target "$TARGET" --target-dir "$CACHE"
    LIBS+=("$CACHE/$TARGET/release/libagentdeck_glance_raster.a")
done
DEST="${BUILT_PRODUCTS_DIR:-$CACHE}/libagentdeck_glance_raster.a"
xcrun lipo -create "${LIBS[@]}" -output "$DEST"
