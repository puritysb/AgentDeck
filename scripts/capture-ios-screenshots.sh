#!/bin/bash
# AgentDeck iOS/iPad Screenshot Capture Script for App Store
# Usage: bash scripts/capture-ios-screenshots.sh

set -e

cd "$(dirname "$0")/.."
APPLE_DIR="./apple"
APP_PATH="$APPLE_DIR/DerivedData/Build/Products/Debug-iphonesimulator/AgentDeck.app"
OUTPUT_DIR="$APPLE_DIR/appstore-screenshots"

# Verify app is built
if [ ! -d "$APP_PATH" ]; then
  echo "App not found at $APP_PATH"
  echo "Building..."
  cd "$APPLE_DIR"
  xcodebuild -scheme AgentDeck_iOS -configuration Debug -sdk iphonesimulator \
    -derivedDataPath ./DerivedData build
  cd ..
fi

# Device names (must match simctl list devices)
# Use iOS 18.6 runtime devices for App Store screenshot compatibility
IPHONE_DEVICE="iPhone 16 Pro Max"
IPAD_DEVICE="iPad Pro 13-inch (M4)"

# Create output directories
mkdir -p "$OUTPUT_DIR/iPhone"
mkdir -p "$OUTPUT_DIR/iPad"

echo "=== AgentDeck Screenshot Capture Helper ==="
echo ""
echo "This script will:"
echo "1. Boot iPhone 15 Pro Max and iPad Pro 13\" simulators"
echo "2. Install the AgentDeck app"
echo "3. Provide you with capture commands for each screen"
echo ""
echo "After each app state change, run the capture command shown."
echo ""

# Boot simulators
echo "Booting simulators..."
xcrun simctl boot "$IPHONE_DEVICE" 2>/dev/null || echo "iPhone already booted"
xcrun simctl boot "$IPAD_DEVICE" 2>/dev/null || echo "iPad already booted"
open -a Simulator
sleep 2

# Install app
echo "Installing AgentDeck on simulators..."
xcrun simctl install "$IPHONE_DEVICE" "$APP_PATH"
xcrun simctl install "$IPAD_DEVICE" "$APP_PATH"
echo "✓ App installed"
echo ""

# Define capture helper function
capture() {
  local device=$1
  local filename=$2
  local output_path="$OUTPUT_DIR/$filename"
  echo "  Capturing: $filename"
  xcrun simctl io "$device" screenshot "$output_path"
  # Get image dimensions
  dimensions=$(sips -g pixelWidth -g pixelHeight "$output_path" | grep pixel | tr '\n' ' ')
  echo "  ✓ Saved: $dimensions"
}

echo "=== SCREENSHOT CAPTURE COMMANDS ==="
echo ""
echo "Copy and paste these commands after navigating to each screen:"
echo ""

cat << 'EOF'
═══════════════════════════════════════════════════════════════════════
IPHONE SCREENSHOTS (6.7" display = 1290x2796)
═══════════════════════════════════════════════════════════════════════

1. DASHBOARD
   Launch app → Wait for main screen → Run:
   xcrun simctl io "iPhone 16 Pro Max" screenshot ./apple/appstore-screenshots/iPhone/01-dashboard.png

2. ONBOARDING
   Reset simulator: xcrun simctl privacy "iPhone 16 Pro Max" reset all
   Terminate: xcrun simctl terminate "iPhone 16 Pro Max" bound.serendipity.agent.deck
   Relaunch for onboarding → Run:
   xcrun simctl io "iPhone 16 Pro Max" screenshot ./apple/appstore-screenshots/iPhone/02-onboarding.png

3. PAIRING / QR SCANNER
   Navigate to pairing/QR screen → Run:
   xcrun simctl io "iPhone 16 Pro Max" screenshot ./apple/appstore-screenshots/iPhone/03-pairing.png

4. DEVICES
   Navigate to device preview → Run:
   xcrun simctl io "iPhone 16 Pro Max" screenshot ./apple/appstore-screenshots/iPhone/04-devices.png

5. SETTINGS
   Open settings → Run:
   xcrun simctl io "iPhone 16 Pro Max" screenshot ./apple/appstore-screenshots/iPhone/05-settings.png

6. TIMELINE / SESSIONS
   Navigate to timeline/activity → Run:
   xcrun simctl io "iPhone 16 Pro Max" screenshot ./apple/appstore-screenshots/iPhone/06-timeline.png

═══════════════════════════════════════════════════════════════════════
IPAD SCREENSHOTS (12.9" display = 2048x2732, LANDSCAPE)
═══════════════════════════════════════════════════════════════════════

Same sequence, but for iPad Pro 13-inch (M4) in landscape mode:

1. xcrun simctl io "iPad Pro 13-inch (M4)" screenshot ./apple/appstore-screenshots/iPad/01-dashboard.png
2. xcrun simctl io "iPad Pro 13-inch (M4)" screenshot ./apple/appstore-screenshots/iPad/02-onboarding.png
3. xcrun simctl io "iPad Pro 13-inch (M4)" screenshot ./apple/appstore-screenshots/iPad/03-pairing.png
4. xcrun simctl io "iPad Pro 13-inch (M4)" screenshot ./apple/appstore-screenshots/iPad/04-devices.png
5. xcrun simctl io "iPad Pro 13-inch (M4)" screenshot ./apple/appstore-screenshots/iPad/05-settings.png
6. xcrun simctl io "iPad Pro 13-inch (M4)" screenshot ./apple/appstore-screenshots/iPad/06-timeline.png

═══════════════════════════════════════════════════════════════════════
VERIFY RESOLUTIONS
═══════════════════════════════════════════════════════════════════════

for f in ./apple/appstore-screenshots/iPhone/*.png; do
  echo "$f: $(sips -g pixelWidth -g pixelHeight "$f" | grep -o '[0-9]* x [0-9]*')"
done

for f in ./apple/appstore-screenshots/iPad/*.png; do
  echo "$f: $(sips -g pixelWidth -g pixelHeight "$f" | grep -o '[0-9]* x [0-9]*')"
done
EOF

echo ""
echo "=== QUICK LAUNCH COMMANDS ==="
echo ""
echo "Launch iPhone app:"
echo "  xcrun simctl launch \"iPhone 16 Pro Max\" bound.serendipity.agent.deck"
echo ""
echo "Launch iPad app:"
echo "  xcrun simctl launch \"iPad Pro 13-inch (M4)\" bound.serendipity.agent.deck"
echo ""
echo "Terminate iPhone app (for clean relaunch):"
echo "  xcrun simctl terminate \"iPhone 16 Pro Max\" bound.serendipity.agent.deck"
echo ""
