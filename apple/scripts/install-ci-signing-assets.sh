#!/bin/bash
set -euo pipefail

# Install the persistent App Store signing assets used by apple-release.yml.
# Usage: install-ci-signing-assets.sh ios|macos
# Set FETCH_ASC_PROFILE=true to read the active profile on the CI runner.
#
# The archive itself is signed with Apple Distribution. This is intentional:
# automatic archive signing asks Apple for a fresh DEVELOPMENT certificate on
# every ephemeral runner and eventually exhausts the account-wide certificate
# cap. Export remains App Store-only and uses explicit distribution profiles.

TARGET="${1:-}"
case "$TARGET" in
    ios|macos) ;;
    *) echo "usage: $0 (ios|macos)" >&2; exit 2 ;;
esac

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${APPLE_DISTRIBUTION_CERTIFICATE_BASE64:?APPLE_DISTRIBUTION_CERTIFICATE_BASE64 is required}"
: "${APPLE_CERTIFICATE_PASSWORD:?APPLE_CERTIFICATE_PASSWORD is required}"

TEAM_ID="QF36NDHYHD"
BUNDLE_ID="bound.serendipity.agent.deck"
KEYCHAIN_PATH="$RUNNER_TEMP/app-signing.keychain-db"
KEYCHAIN_PASSWORD="$(openssl rand -hex 24)"
DIST_P12="$RUNNER_TEMP/apple-distribution.p12"

echo -n "$APPLE_DISTRIBUTION_CERTIFICATE_BASE64" | base64 --decode -o "$DIST_P12"

security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security import "$DIST_P12" -P "$APPLE_CERTIFICATE_PASSWORD" -A -k "$KEYCHAIN_PATH" >/dev/null

if [[ "$TARGET" == "macos" ]]; then
    : "${APPLE_INSTALLER_CERTIFICATE_BASE64:?APPLE_INSTALLER_CERTIFICATE_BASE64 is required for macOS}"
    INSTALLER_P12="$RUNNER_TEMP/apple-installer.p12"
    echo -n "$APPLE_INSTALLER_CERTIFICATE_BASE64" | base64 --decode -o "$INSTALLER_P12"
    security import "$INSTALLER_P12" -P "$APPLE_CERTIFICATE_PASSWORD" -A -k "$KEYCHAIN_PATH" >/dev/null
fi

security set-key-partition-list -S apple-tool:,apple: -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security list-keychain -d user -s "$KEYCHAIN_PATH"

DIST_IDENTITY=$(security find-identity -v -p codesigning "$KEYCHAIN_PATH" \
    | sed -n 's/.*"\(Apple Distribution: .* (QF36NDHYHD)\)".*/\1/p' \
    | head -1)
if [[ -z "$DIST_IDENTITY" ]]; then
    echo "::error::No Apple Distribution private-key identity for team $TEAM_ID was imported."
    exit 1
fi
echo "Installed distribution identity for team $TEAM_ID."

if [[ "$TARGET" == "ios" ]]; then
    PROFILE_BASE64="${IOS_PROVISIONING_PROFILE_BASE64:-}"
    PROFILE_PATH="$RUNNER_TEMP/agentdeck.mobileprovision"
    PROFILE_SUFFIX="mobileprovision"
    PROFILE_APP_ID_KEY="application-identifier"
else
    PROFILE_BASE64="${MACOS_PROVISIONING_PROFILE_BASE64:-}"
    PROFILE_PATH="$RUNNER_TEMP/agentdeck.provisionprofile"
    PROFILE_SUFFIX="provisionprofile"
    PROFILE_APP_ID_KEY="com.apple.application-identifier"

    INSTALLER_IDENTITY=$(security find-identity -v -p basic "$KEYCHAIN_PATH" \
        | sed -n 's/.*"\(3rd Party Mac Developer Installer: .* (QF36NDHYHD)\)".*/\1/p' \
        | head -1)
    if [[ -z "$INSTALLER_IDENTITY" ]]; then
        echo "::error::No Mac Installer Distribution private-key identity for team $TEAM_ID was imported."
        exit 1
    fi
    {
        echo 'MAC_INSTALLER_IDENTITY<<AGENTDECK_IDENTITY_EOF'
        echo "$INSTALLER_IDENTITY"
        echo 'AGENTDECK_IDENTITY_EOF'
    } >> "$GITHUB_ENV"
    echo "Installed Mac installer identity for team $TEAM_ID."
fi

if [[ "${FETCH_ASC_PROFILE:-false}" == "true" ]]; then
    node apple/scripts/fetch-appstore-profile.mjs "$TARGET" "$PROFILE_PATH"
else
    : "${PROFILE_BASE64:?App Store profile secret is required}"
    printf '%s' "$PROFILE_BASE64" | base64 --decode -o "$PROFILE_PATH"
fi
PROFILE_PLIST="$RUNNER_TEMP/agentdeck-profile.plist"
security cms -D -i "$PROFILE_PATH" > "$PROFILE_PLIST"

PROFILE_UUID=$(/usr/libexec/PlistBuddy -c 'Print :UUID' "$PROFILE_PLIST")
PROFILE_TEAM=$(/usr/libexec/PlistBuddy -c 'Print :TeamIdentifier:0' "$PROFILE_PLIST")
PROFILE_APP_ID=$(/usr/libexec/PlistBuddy -c "Print :Entitlements:$PROFILE_APP_ID_KEY" "$PROFILE_PLIST")

if [[ "$PROFILE_TEAM" != "$TEAM_ID" ]]; then
    echo "::error::Provisioning profile belongs to team $PROFILE_TEAM, expected $TEAM_ID."
    exit 1
fi
if [[ "$PROFILE_APP_ID" != "$TEAM_ID.$BUNDLE_ID" ]]; then
    echo "::error::Provisioning profile targets $PROFILE_APP_ID, expected $TEAM_ID.$BUNDLE_ID."
    exit 1
fi

python3 - "$PROFILE_PLIST" "$TARGET" <<'PYPROFILE'
import plistlib
import sys
from datetime import datetime

path, platform = sys.argv[1:]
with open(path, "rb") as file:
    profile = plistlib.load(file)
entitlements = profile["Entitlements"]
environment = entitlements.get("com.apple.developer.icloud-container-environment", [])
if isinstance(environment, str):
    environment = [environment]
if profile["ExpirationDate"] <= datetime.utcnow():
    sys.exit("App Store profile is expired.")
if ("iCloud.bound.serendipity.agent.deck" not in entitlements.get("com.apple.developer.icloud-container-identifiers", [])
        or "CloudKit" not in entitlements.get("com.apple.developer.icloud-services", [])
        or "Production" not in environment):
    sys.exit("App Store profile lacks the AgentDeck Production CloudKit entitlement.")
if platform == "ios" and entitlements.get("aps-environment") != "production":
    sys.exit("iOS App Store profile lacks the production APNs entitlement.")
print("App Store profile permits Production CloudKit" + (" and production APNs." if platform == "ios" else "."))
PYPROFILE

mkdir -p "$HOME/Library/MobileDevice/Provisioning Profiles"
cp "$PROFILE_PATH" "$HOME/Library/MobileDevice/Provisioning Profiles/$PROFILE_UUID.$PROFILE_SUFFIX"
echo "Installed $TARGET App Store profile $PROFILE_UUID."
