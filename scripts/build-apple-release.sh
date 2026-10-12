#!/bin/bash
set -euo pipefail

# AgentDeck Apple Release — local build + TestFlight upload
# Usage: bash scripts/build-apple-release.sh [--ios|--macos|--all]
#
# Prerequisites:
#   1. Xcode with valid signing certificate
#   2. App Store Connect API key at ~/private_keys/AuthKey_<KEY_ID>.p8
#      Set env: ASC_API_KEY_ID, ASC_ISSUER_ID

# Ensure system rsync is used (Homebrew rsync lacks -E/--extended-attributes
# which Xcode's exportArchive requires)
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
APPLE_DIR="$PROJECT_DIR/apple"
DIST_DIR="$PROJECT_DIR/dist"
PROJECT="$APPLE_DIR/AgentDeck.xcodeproj"
IOS_EXPORT_PLIST="$APPLE_DIR/ExportOptions.plist"
MACOS_EXPORT_PLIST="$APPLE_DIR/ExportOptions-macOS.plist"

# Parse version from project.yml
VERSION=$(grep 'MARKETING_VERSION' "$APPLE_DIR/project.yml" | head -1 | sed 's/.*: *"\(.*\)"/\1/')
echo "=== AgentDeck Apple v${VERSION} ==="

# Parse arguments
TARGET="${1:---all}"

build_ios() {
    echo ""
    echo ">>> Archiving iOS..."
    ARCHIVE_PATH="$DIST_DIR/AgentDeck_iOS.xcarchive"
    rm -rf "$ARCHIVE_PATH"

    xcodebuild archive \
        -project "$PROJECT" \
        -scheme AgentDeck_iOS \
        -configuration Release \
        -destination 'generic/platform=iOS' \
        -archivePath "$ARCHIVE_PATH" \
        -allowProvisioningUpdates \
        MARKETING_VERSION="$VERSION" \
        CODE_SIGN_STYLE=Manual \
        CODE_SIGN_IDENTITY="Apple Distribution" \
        PROVISIONING_PROFILE_SPECIFIER="AgentDeck Dashboard AppStore" \
        DEVELOPMENT_TEAM=QF36NDHYHD \
        | tail -5

    echo ">>> Exporting IPA..."
    EXPORT_PATH="$DIST_DIR/export_ios"
    rm -rf "$EXPORT_PATH"

    xcodebuild -exportArchive \
        -archivePath "$ARCHIVE_PATH" \
        -exportOptionsPlist "$IOS_EXPORT_PLIST" \
        -exportPath "$EXPORT_PATH" \
        -allowProvisioningUpdates \
        | tail -5

    IPA_PATH="$EXPORT_PATH/AgentDeck.ipa"
    if [ -f "$IPA_PATH" ]; then
        echo ">>> Verifying exported iOS App Store invariants..."
        VERIFY_PATH="$(mktemp -d "$DIST_DIR/verify-ios.XXXXXX")"
        unzip -q "$IPA_PATH" -d "$VERIFY_PATH"
        bash "$APPLE_DIR/scripts/verify-appstore-archive.sh" \
            "$VERIFY_PATH/Payload/AgentDeck.app"
        rm -rf "$VERIFY_PATH"

        cp "$IPA_PATH" "$DIST_DIR/agentdeck-ios-v${VERSION}.ipa"
        echo ">>> iOS IPA: dist/agentdeck-ios-v${VERSION}.ipa"
    else
        echo "ERROR: IPA not found at $IPA_PATH"
        exit 1
    fi
}

build_macos() {
    echo ""
    echo ">>> Archiving macOS..."
    ARCHIVE_PATH="$DIST_DIR/AgentDeck_macOS.xcarchive"
    rm -rf "$ARCHIVE_PATH"

    xcodebuild archive \
        -project "$PROJECT" \
        -scheme AgentDeck_macOS \
        -configuration Release \
        -destination 'generic/platform=macOS' \
        -archivePath "$ARCHIVE_PATH" \
        -allowProvisioningUpdates \
        MARKETING_VERSION="$VERSION" \
        CODE_SIGN_STYLE=Manual \
        CODE_SIGN_IDENTITY="Apple Distribution" \
        PROVISIONING_PROFILE_SPECIFIER="AgentDeck Dashboard macOS AppStore" \
        DEVELOPMENT_TEAM=QF36NDHYHD \
        | tail -5

    echo ">>> Exporting macOS app..."
    EXPORT_PATH="$DIST_DIR/export_macos"
    rm -rf "$EXPORT_PATH"

    xcodebuild -exportArchive \
        -archivePath "$ARCHIVE_PATH" \
        -exportOptionsPlist "$MACOS_EXPORT_PLIST" \
        -exportPath "$EXPORT_PATH" \
        -allowProvisioningUpdates \
        | tail -5

    PKG_PATH=$(find "$EXPORT_PATH" -name "*.pkg" -type f | head -1)
    if [ -z "${PKG_PATH:-}" ]; then
        echo "ERROR: macOS pkg not found under $EXPORT_PATH"
        exit 1
    fi

    echo ">>> Verifying exported macOS App Store invariants..."
    VERIFY_PATH="$(mktemp -d "$DIST_DIR/verify-macos.XXXXXX")"
    PKG_EXPANDED="$VERIFY_PATH/pkg"
    pkgutil --expand-full "$PKG_PATH" "$PKG_EXPANDED"
    APP_PATH=$(find "$PKG_EXPANDED" -type d -name "AgentDeck.app" | head -1)
    if [ -z "${APP_PATH:-}" ]; then
        echo "ERROR: AgentDeck.app not found in exported pkg"
        exit 1
    fi
    bash "$APPLE_DIR/scripts/verify-appstore-archive.sh" "$APP_PATH"
    rm -rf "$VERIFY_PATH"

    echo ">>> macOS export: dist/export_macos/"
}

upload_testflight() {
    if [ -z "${ASC_API_KEY_ID:-}" ] || [ -z "${ASC_ISSUER_ID:-}" ]; then
        echo ""
        echo ">>> Skipping TestFlight upload (ASC_API_KEY_ID / ASC_ISSUER_ID not set)"
        echo "    Set these env vars and place AuthKey at ~/private_keys/ to enable upload"
        return
    fi

    echo ""
    echo ">>> Uploading to TestFlight..."

    if [ -f "$DIST_DIR/agentdeck-ios-v${VERSION}.ipa" ]; then
        xcrun altool --upload-app \
            -f "$DIST_DIR/agentdeck-ios-v${VERSION}.ipa" \
            -t ios \
            --apiKey "$ASC_API_KEY_ID" \
            --apiIssuer "$ASC_ISSUER_ID"
        echo ">>> iOS uploaded to TestFlight"
    fi

    PKG_PATH=$(find "$DIST_DIR/export_macos" -name "*.pkg" 2>/dev/null | head -1)
    if [ -n "${PKG_PATH:-}" ]; then
        xcrun altool --upload-app \
            -f "$PKG_PATH" \
            -t macos \
            --apiKey "$ASC_API_KEY_ID" \
            --apiIssuer "$ASC_ISSUER_ID"
        echo ">>> macOS uploaded to App Store Connect"
    fi
}

mkdir -p "$DIST_DIR"

case "$TARGET" in
    --ios)
        build_ios
        upload_testflight
        ;;
    --macos)
        build_macos
        upload_testflight
        ;;
    --all)
        build_ios
        build_macos
        upload_testflight
        ;;
    *)
        echo "Usage: $0 [--ios|--macos|--all]"
        exit 1
        ;;
esac

echo ""
echo "=== Done ==="
