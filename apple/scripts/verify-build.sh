#!/bin/bash
# Unsigned local verification of the same configurations checked by Apple CI.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PLATFORM="${1:?macOS or iOS required}"
CONFIGURATION="${2:?build configuration required}"
case "$CONFIGURATION" in
    Debug|Release) DOT_MODE=excluded ;;
    DotPreviewDebug|DotPreviewRelease) DOT_MODE=preview ;;
    *) echo "Unknown configuration: $CONFIGURATION" >&2; exit 2 ;;
esac
DERIVED="${AGENTDECK_APPLE_DERIVED_DATA:-$ROOT/apple/build/verification/DerivedData}"
case "$PLATFORM" in
    macOS)
        ACTION=test
        if [ "$CONFIGURATION" = Release ]; then ACTION=build; fi
        DESTINATION='platform=macOS'; PRODUCTS="$CONFIGURATION"
        ;;
    iOS) ACTION=build; DESTINATION='generic/platform=iOS Simulator'; PRODUCTS="$CONFIGURATION-iphonesimulator" ;;
    *) echo "Unknown platform: $PLATFORM" >&2; exit 2 ;;
esac
xcodegen generate --spec "$ROOT/apple/project.yml"
xcodebuild "$ACTION" -project "$ROOT/apple/AgentDeck.xcodeproj" \
    -scheme "AgentDeck_$PLATFORM" -configuration "$CONFIGURATION" \
    -destination "$DESTINATION" -derivedDataPath "$DERIVED" CODE_SIGNING_ALLOWED=NO
python3 "$ROOT/apple/scripts/verify-dot-build.py" "$DERIVED/Build/Products/$PRODUCTS/AgentDeck.app" "$DOT_MODE"
