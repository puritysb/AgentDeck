#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ANDROID_DIR="$PROJECT_DIR/android"
OUTPUT_DIR="$PROJECT_DIR/dist"

# Read version from build.gradle.kts
VERSION=$(grep 'versionName' "$ANDROID_DIR/app/build.gradle.kts" | head -1 | sed 's/.*"\(.*\)".*/\1/')
APK_NAME="agentdeck-v${VERSION}.apk"

echo "Building AgentDeck Android v${VERSION}..."

# Ensure JDK 17+
if ! java -version 2>&1 | grep -q '"1[7-9]\.\|"[2-9][0-9]\.'; then
  if [ -d "$(brew --prefix openjdk@17 2>/dev/null)/libexec/openjdk.jdk/Contents/Home" ]; then
    export JAVA_HOME="$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home"
    echo "Using JAVA_HOME=$JAVA_HOME"
  elif /usr/libexec/java_home -v 17 >/dev/null 2>&1; then
    export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
    echo "Using JAVA_HOME=$JAVA_HOME"
  else
    echo "Error: JDK 17+ required. Install with: brew install openjdk@17"
    exit 1
  fi
fi

# Check signing.properties
if [ ! -f "$ANDROID_DIR/signing.properties" ]; then
  echo "Error: android/signing.properties not found."
  echo ""
  echo "Create it with:"
  echo "  storeFile=agentdeck-release.jks"
  echo "  keyAlias=agentdeck"
  echo "  keyPassword=<your-password>"
  echo "  storePassword=<your-password>"
  exit 1
fi

# Build release APK
cd "$ANDROID_DIR"
./gradlew assembleSideload

# Copy to dist/
mkdir -p "$OUTPUT_DIR"
cp "$ANDROID_DIR/app/build/outputs/apk/sideload/app-sideload.apk" "$OUTPUT_DIR/$APK_NAME"

echo ""
echo "APK created: dist/$APK_NAME"
echo "Size: $(du -h "$OUTPUT_DIR/$APK_NAME" | cut -f1)"

# Install to connected devices (--install flag)
if [[ "${1:-}" == "--install" ]]; then
  if ! command -v adb &>/dev/null; then
    echo "Error: adb not found. Install with: brew install android-platform-tools"
    exit 1
  fi

  DEVICES=$(adb devices | tail -n +2 | grep -w "device" | cut -f1)
  if [ -z "$DEVICES" ]; then
    echo "No connected devices found."
    exit 1
  fi

  echo ""
  for DEVICE in $DEVICES; do
    echo "Installing on $DEVICE..."
    if ! adb -s "$DEVICE" install -r "$OUTPUT_DIR/$APK_NAME" 2>&1 | grep -q "Success"; then
      echo "  Signature mismatch — uninstalling old version..."
      adb -s "$DEVICE" uninstall dev.agentdeck
      adb -s "$DEVICE" install "$OUTPUT_DIR/$APK_NAME"
    fi
  done
  echo "Done — installed on $(echo "$DEVICES" | wc -l | tr -d ' ') device(s)."
fi
