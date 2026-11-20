#!/bin/bash
set -euo pipefail

# Install the persistent App Store signing assets used by apple-release.yml.
# Usage: install-ci-signing-assets.sh ios|macos
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
    : "${IOS_PROVISIONING_PROFILE_BASE64:?IOS_PROVISIONING_PROFILE_BASE64 is required}"
    PROFILE_BASE64="$IOS_PROVISIONING_PROFILE_BASE64"
    PROFILE_PATH="$RUNNER_TEMP/agentdeck.mobileprovision"
    PROFILE_SUFFIX="mobileprovision"
    PROFILE_APP_ID_KEY="application-identifier"
else
    : "${MACOS_PROVISIONING_PROFILE_BASE64:?MACOS_PROVISIONING_PROFILE_BASE64 is required}"
    PROFILE_BASE64="$MACOS_PROVISIONING_PROFILE_BASE64"
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

install_profile() {
    local base64="$1" path="$2" suffix="$3" app_id_key="$4" bundle_id="$5"
    echo -n "$base64" | base64 --decode -o "$path"
    local plist="$path.plist"
    security cms -D -i "$path" > "$plist"
    local uuid team app_id
    uuid=$(/usr/libexec/PlistBuddy -c 'Print :UUID' "$plist")
    team=$(/usr/libexec/PlistBuddy -c 'Print :TeamIdentifier:0' "$plist")
    app_id=$(/usr/libexec/PlistBuddy -c "Print :Entitlements:$app_id_key" "$plist")
    if [[ "$team" != "$TEAM_ID" ]]; then
        echo "::error::Provisioning profile belongs to team $team, expected $TEAM_ID."
        exit 1
    fi
    if [[ "$app_id" != "$TEAM_ID.$bundle_id" ]]; then
        echo "::error::Provisioning profile targets $app_id, expected $TEAM_ID.$bundle_id."
        exit 1
    fi
    python3 apple/scripts/check-profile-entitlements.py "$plist" "$6"
    mkdir -p "$HOME/Library/MobileDevice/Provisioning Profiles"
    cp "$path" "$HOME/Library/MobileDevice/Provisioning Profiles/$uuid.$suffix"
    echo "Installed App Store profile $uuid for $bundle_id."
}

case "$TARGET" in
    ios) requested=apple/AgentDeck/Resources/AgentDeck-iOS.entitlements ;;
    macos) requested=apple/AgentDeck/Resources/AgentDeck.entitlements ;;
esac
install_profile "$PROFILE_BASE64" "$PROFILE_PATH" "$PROFILE_SUFFIX" "$PROFILE_APP_ID_KEY" "$BUNDLE_ID" "$requested"

# The iOS archive embeds the Watch app and its complication extension; each is
# signed with its own App Store profile (apple/project.yml release configs).
if [[ "$TARGET" == "ios" ]]; then
    : "${WATCH_PROVISIONING_PROFILE_BASE64:?WATCH_PROVISIONING_PROFILE_BASE64 is required (AgentDeck Watch AppStore)}"
    : "${WATCH_WIDGETS_PROVISIONING_PROFILE_BASE64:?WATCH_WIDGETS_PROVISIONING_PROFILE_BASE64 is required (AgentDeck Watch Widgets AppStore)}"
    install_profile "$WATCH_PROVISIONING_PROFILE_BASE64" "$RUNNER_TEMP/agentdeck-watch.mobileprovision" \
        mobileprovision application-identifier "$BUNDLE_ID.watchkitapp" apple/AgentDeckWatch/Resources/AgentDeckWatch.entitlements
    install_profile "$WATCH_WIDGETS_PROVISIONING_PROFILE_BASE64" "$RUNNER_TEMP/agentdeck-watch-widgets.mobileprovision" \
        mobileprovision application-identifier "$BUNDLE_ID.watchkitapp.widgets" apple/AgentDeckWatchWidgets/Resources/AgentDeckWatchWidgets.entitlements
fi
