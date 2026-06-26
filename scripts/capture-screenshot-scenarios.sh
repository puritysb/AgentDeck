#!/bin/bash
# AgentDeck App Store Screenshot Capture - Full Scenario Workflow
# Usage: bash scripts/capture-screenshot-scenarios.sh

set -e

cd "$(dirname "$0")/.."
APPLE_DIR="./apple"
OUTPUT_DIR="$APPLE_DIR/appstore-screenshots"

# Device names
IPHONE="iPhone 16 Pro Max"
IPAD="iPad Pro 13-inch (M4)"

# Ensure simulators are running
echo "=== AgentDeck Screenshot Scenario Capture ==="
echo ""

# Boot and install
xcrun simctl boot "$IPHONE" 2>/dev/null || true
xcrun simctl boot "$IPAD" 2>/dev/null || true
open -a Simulator
sleep 2

APP_PATH="$APPLE_DIR/DerivedData/Build/Products/Debug-iphonesimulator/AgentDeck.app"
if [ ! -d "$APP_PATH" ]; then
  echo "Building app..."
  cd "$APPLE_DIR"
  xcodebuild -scheme AgentDeck_iOS -configuration Debug -sdk iphonesimulator \
    -derivedDataPath ./DerivedData build
  cd ..
fi

xcrun simctl install "$IPHONE" "$APP_PATH"
xcrun simctl install "$IPAD" "$APP_PATH"
echo "✓ App installed"
echo ""

# Create directories
mkdir -p "$OUTPUT_DIR/iPhone"
mkdir -p "$OUTPUT_DIR/iPad/videos"

# ============================================================================
# IPHONE SCENARIOS
# ============================================================================
echo "═══════════════════════════════════════════════════════════════"
echo "IPHONE SCREENSHOT SCENARIOS"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Scenario 1: Dashboard (IDLE state)
echo "📱 Scenario 1: Dashboard - IDLE State"
echo "   Launch app, wait for dashboard to load"
xcrun simctl launch "$IPHONE" bound.serendipity.agent.deck
echo "   Press Enter when dashboard is visible..."
read
xcrun simctl io "$IPHONE" screenshot "$OUTPUT_DIR/iPhone/01-dashboard-idle.png"
echo "   ✓ Captured"
echo ""

# Scenario 2: Active Session (PROCESSING state)
echo "📱 Scenario 2: Active Session - PROCESSING"
echo "   This requires a real daemon session running"
echo "   Start a Claude Code session in Terminal"
echo "   Then press Enter when you see PROCESSING state..."
read
xcrun simctl io "$IPHONE" screenshot "$OUTPUT_DIR/iPhone/02-active-session.png"
echo "   ✓ Captured"
echo ""

# Scenario 3: Onboarding
echo "📱 Scenario 3: Onboarding"
echo "   Resetting app state..."
xcrun simctl terminate "$IPHONE" bound.serendipity.agent.deck
xcrun simctl privacy "$IPHONE" reset all
sleep 1
xcrun simctl launch "$IPHONE" bound.serendipity.agent.deck
echo "   Navigate through onboarding screens"
echo "   Press Enter when on welcome screen..."
read
xcrun simctl io "$IPHONE" screenshot "$OUTPUT_DIR/iPhone/03-onboarding.png"
echo "   ✓ Captured"
echo ""

# Scenario 4: Device Gallery
echo "📱 Scenario 4: Device Gallery"
echo "   Navigate to device preview"
echo "   Press Enter when device gallery is visible..."
read
xcrun simctl io "$IPHONE" screenshot "$OUTPUT_DIR/iPhone/04-devices.png"
echo "   ✓ Captured"
echo ""

# Scenario 5: Settings
echo "📱 Scenario 5: Settings"
echo "   Open settings screen"
echo "   Press Enter when settings is visible..."
read
xcrun simctl io "$IPHONE" screenshot "$OUTPUT_DIR/iPhone/05-settings.png"
echo "   ✓ Captured"
echo ""

# Scenario 6: Timeline/Activity
echo "📱 Scenario 6: Timeline Activity"
echo "   Navigate to timeline view"
echo "   Press Enter when timeline is visible..."
read
xcrun simctl io "$IPHONE" screenshot "$OUTPUT_DIR/iPhone/06-timeline.png"
echo "   ✓ Captured"
echo ""

# ============================================================================
# IPAD SCENARIOS (rotate to landscape first)
# ============================================================================
echo "═══════════════════════════════════════════════════════════════"
echo "IPAD SCREENSHOT SCENARIOS (LANDSCAPE)"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "⚠️  Please rotate iPad simulator to landscape (Cmd+Right Arrow)"
echo "   Press Enter when ready..."
read

# Same scenarios for iPad
for i in {1..6}; do
  case $i in
    1) name="dashboard-idle" ;;
    2) name="active-session" ;;
    3) name="onboarding" ;;
    4) name="devices" ;;
    5) name="settings" ;;
    6) name="timeline" ;;
  esac

  echo "📸 iPad Scenario $i: $name"
  echo "   Navigate to the $name screen"
  echo "   Press Enter to capture..."
  read
  xcrun simctl io "$IPAD" screenshot "$OUTPUT_DIR/iPad/$(printf '%02d' $i)-$name.png"
  echo "   ✓ Captured"
  echo ""
done

# ============================================================================
# VIDEO PREVIEWS
# ============================================================================
echo "═══════════════════════════════════════════════════════════════"
echo "APP PREVIEW VIDEOS (15-30 seconds each)"
echo "═══════════════════════════════════════════════════════════════"
echo ""

echo "🎥 Video 1: Meet AgentDeck (30 sec)"
echo "   Start recording, then:"
echo "   1. Show dashboard with creature"
echo "   2. Launch a session"
echo "   3. Show device gallery"
echo "   Press Enter to START recording..."
read
xcrun simctl io "$IPHONE" recordVideo --output="$OUTPUT_DIR/iPhone/videos/01-meet-agentdeck.mov" --type=mp4 &
RECORD_PID=$!
echo "   📹 Recording... Press Enter to STOP (30 sec max)..."
read
kill -INT $RECORD_PID 2>/dev/null || true
wait $RECORD_PID 2>/dev/null || true
echo "   ✓ Video captured"
echo ""

echo "🎥 Video 2: Your Sessions, Controlled (30 sec)"
echo "   Start recording for multi-session scenario"
echo "   Press Enter to START recording..."
read
xcrun simctl io "$IPHONE" recordVideo --output="$OUTPUT_DIR/iPhone/videos/02-sessions-controlled.mov" --type=mp4 &
RECORD_PID=$!
echo "   📹 Recording... Press Enter to STOP..."
read
kill -INT $RECORD_PID 2>/dev/null || true
wait $RECORD_PID 2>/dev/null || true
echo "   ✓ Video captured"
echo ""

# ============================================================================
# VERIFY
# ============================================================================
echo "═══════════════════════════════════════════════════════════════"
echo "VERIFICATION"
echo "═══════════════════════════════════════════════════════════════"
echo ""

echo "iPhone screenshots:"
for f in "$OUTPUT_DIR/iPhone"/*.png; do
  if [ -f "$f" ]; then
    dims=$(sips -g pixelWidth -g pixelHeight "$f" 2>/dev/null | grep pixel | tr '\n' ' ')
    echo "  $(basename "$f"): $dims"
  fi
done

echo ""
echo "iPad screenshots:"
for f in "$OUTPUT_DIR/iPad"/*.png; do
  if [ -f "$f" ]; then
    dims=$(sips -g pixelWidth -g pixelHeight "$f" 2>/dev/null | grep pixel | tr '\n' ' ')
    echo "  $(basename "$f"): $dims"
  fi
done

echo ""
echo "Videos:"
for f in "$OUTPUT_DIR/iPhone/videos"/*.mov; do
  if [ -f "$f" ]; then
    size=$(du -h "$f" | cut -f1)
    echo "  $(basename "$f"): $size"
  fi
done

echo ""
echo "✓ Screenshot capture complete!"
echo "  Screenshots: $OUTPUT_DIR/iPhone/ and $OUTPUT_DIR/iPad/"
echo "  Videos: $OUTPUT_DIR/iPhone/videos/"
