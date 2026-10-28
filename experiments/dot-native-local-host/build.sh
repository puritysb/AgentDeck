#!/bin/bash
# Developer tooling only. Never installs, launches or stops an application.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MODE="${1:-}"
IDENTITY="${2:-}"
PROFILE="${4:-}"
if { [[ "$MODE" == --compile-only ]] && [[ $# != 1 ]]; } || \
   { [[ "$MODE" == --sign ]] && { [[ $# != 4 ]] || [[ "${3:-}" != --profile ]] || [[ ! "$IDENTITY" =~ ^[A-Fa-f0-9]{40}$ ]]; }; } || \
   { [[ "$MODE" != --compile-only ]] && [[ "$MODE" != --sign ]]; }; then
  echo 'Usage: build.sh --compile-only | --sign <identity SHA1> --profile <Mac development profile>' >&2
  exit 2
fi
BUILD="$HERE/build"
if [[ "$MODE" == --sign ]]; then
  # A valid signature alone does not authorize restricted Keychain entitlements.
  # Refuse an ineligible profile before producing or replacing a signed artifact.
  python3 "$HERE/verify.py" --check-profile "$PROFILE" "$IDENTITY"
  OUTPUT="$BUILD/signed"
else
  OUTPUT="$BUILD/unsigned"
fi
APP="$OUTPUT/AgentDeckDotLocalHost.app"
mkdir -p "$BUILD/module-cache" "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/apple/AgentDeck/Resources/dot-mcp-contract.json" "$APP/Contents/Resources/dot-mcp-contract.json"
SOURCES=()
while IFS= read -r source; do
  [[ -n "$source" ]] && SOURCES+=("$ROOT/$source")
done < "$HERE/sources.txt"
ARCH="$(uname -m)"
SDK="$(xcrun --sdk macosx --show-sdk-path)"
xcrun swiftc -parse-as-library -swift-version 6 -O -sdk "$SDK" \
  -target "$ARCH-apple-macosx26.0" -module-cache-path "$BUILD/module-cache" \
  -D AGENTDECK_APP_STORE -D AGENTDECK_DOT_PREVIEW \
  "${SOURCES[@]}" "$HERE/HostApp.swift" -o "$APP/Contents/MacOS/AgentDeckDotLocalHost" \
  > "$OUTPUT/compile.log" 2>&1 || { tail -70 "$OUTPUT/compile.log"; exit 1; }
python3 "$HERE/verify.py" --record-sources "$APP"
if [[ "$MODE" == --sign ]]; then
  cp "$PROFILE" "$APP/Contents/embedded.provisionprofile"
  codesign --force --options runtime --timestamp --sign "$IDENTITY" \
    --entitlements "$HERE/Host.entitlements" "$APP"
  python3 "$HERE/verify.py" "$APP"
else
  echo 'Compiled only. This artifact must not be used as signed sandbox evidence.'
fi
echo "$APP"
