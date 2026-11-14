#!/bin/bash
# Unsigned local verification of the same configurations checked by Apple CI.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PLATFORM="${1:?macOS, iOS or watchOS required}"
CONFIGURATION="${2:?build configuration required}"
SCHEME="AgentDeck_$PLATFORM"
set --
case "$CONFIGURATION" in
    Debug|Release) DOT_MODE=excluded ;;
    CloudKitPoCDebug) DOT_MODE=excluded; SCHEME="AgentDeck_CloudKitPoC_$PLATFORM" ;;
    DotPreviewDebug|DotPreviewRelease) DOT_MODE=preview ;;
    *) echo "Unknown configuration: $CONFIGURATION" >&2; exit 2 ;;
esac
DERIVED="${AGENTDECK_APPLE_DERIVED_DATA:-$ROOT/apple/build/verification/DerivedData}"
case "$PLATFORM" in
    macOS)
        ACTION=test
        if [ "$CONFIGURATION" = Release ]; then ACTION=build; fi
        DESTINATION='platform=macOS'; PRODUCTS="$CONFIGURATION"
        if [ "$CONFIGURATION" = CloudKitPoCDebug ]; then
            set -- -only-testing:AgentDeckTests_macOS/CloudKitProbeTests \
                   -only-testing:AgentDeckTests_macOS/RemoteObservationProjectionTests \
                   -only-testing:AgentDeckTests_macOS/RemoteObservationPersistenceTests \
                   -only-testing:AgentDeckTests_macOS/RemoteGlanceTests \
                   -only-testing:AgentDeckTests_macOS/WatchObservationModelTests
        fi
        ;;
    iOS) ACTION=build; DESTINATION='generic/platform=iOS Simulator'; PRODUCTS="$CONFIGURATION-iphonesimulator" ;;
    watchOS)
        [ "$CONFIGURATION" = CloudKitPoCDebug ] || { echo "Watch verification is development-only" >&2; exit 2; }
        ACTION=build; DESTINATION='generic/platform=watchOS Simulator'; PRODUCTS="$CONFIGURATION-watchsimulator"
        ;;
    *) echo "Unknown platform: $PLATFORM" >&2; exit 2 ;;
esac
xcodegen generate --spec "$ROOT/apple/project.yml"
xcodebuild "$ACTION" -project "$ROOT/apple/AgentDeck.xcodeproj" \
    -scheme "$SCHEME" -configuration "$CONFIGURATION" \
    -destination "$DESTINATION" -derivedDataPath "$DERIVED" CODE_SIGNING_ALLOWED=NO "$@"
if [ "$PLATFORM" != watchOS ]; then
    python3 "$ROOT/apple/scripts/verify-dot-build.py" "$DERIVED/Build/Products/$PRODUCTS/AgentDeck.app" "$DOT_MODE"
fi

if [ "$PLATFORM" = watchOS ]; then
    test -f "$DERIVED/Build/Products/$PRODUCTS/AgentDeck.app/PlugIns/AgentDeckWatchWidgets.appex/AgentDeckWatchWidgets"
fi
