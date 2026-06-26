# App Store Screenshot Capture Guide

## Status

✅ **iPhone 01-dashboard.png** (1320x2868)
✅ **iPad 01-dashboard.png** (2064x2752)

## Quick Reference Commands

### iPhone (iPhone 16 Pro Max)

```bash
# Launch iPhone app
xcrun simctl launch "iPhone 16 Pro Max" bound.serendipity.agent.deck

# Terminate (for clean relaunch)
xcrun simctl terminate "iPhone 16 Pro Max" bound.serendipity.agent.deck

# Reset for onboarding
xcrun simctl privacy "iPhone 16 Pro Max" reset all
```

**Screenshot capture:**
```bash
xcrun simctl io "iPhone 16 Pro Max" screenshot ./apple/appstore-screenshots/iPhone/FILENAME.png
```

### iPad (iPad Pro 13-inch M4)

```bash
# Launch iPad app
xcrun simctl launch "iPad Pro 13-inch (M4)" bound.serendipity.agent.deck

# Terminate
xcrun simctl terminate "iPad Pro 13-inch (M4)" bound.serendipity.agent.deck

# Reset for onboarding
xcrun simctl privacy "iPad Pro 13-inch (M4)" reset all
```

**Screenshot capture:**
```bash
xcrun simctl io "iPad Pro 13-inch (M4)" screenshot ./apple/appstore-screenshots/iPad/FILENAME.png
```

## Screenshots to Capture (Remaining)

### iPhone (5 remaining)

| # | Screen | Filename | How to Reach |
|---|--------|----------|--------------|
| 2 | Onboarding | 02-onboarding.png | Reset privacy → Relaunch app |
| 3 | Pairing/QR | 03-pairing.png | Navigate to pairing/QR scanner |
| 4 | Devices | 04-devices.png | Navigate to device preview |
| 5 | Settings | 05-settings.png | Open settings screen |
| 6 | Timeline | 06-timeline.png | Navigate to timeline/activity |

### iPad (5 remaining)

| # | Screen | Filename | How to Reach |
|---|--------|----------|--------------|
| 2 | Onboarding | 02-onboarding.png | Reset privacy → Relaunch (landscape) |
| 3 | Pairing/QR | 03-pairing.png | Navigate to pairing/QR scanner |
| 4 | Devices | 04-devices.png | Navigate to device preview |
| 5 | Settings | 05-settings.png | Open settings screen |
| 6 | Timeline | 06-timeline.png | Navigate to timeline/activity |

## Verify Resolution

```bash
# Check all iPhone screenshots
for f in ./apple/appstore-screenshots/iPhone/*.png; do
  echo "$f: $(sips -g pixelWidth -g pixelHeight "$f" | grep -o '[0-9]* x [0-9]*')"
done

# Check all iPad screenshots
for f in ./apple/appstore-screenshots/iPad/*.png; do
  echo "$f: $(sips -g pixelWidth -g pixelHeight "$f" | grep -o '[0-9]* x [0-9]*')"
done
```

## App Store Requirements

- **iPhone**: 1290x2796 (6.7" display) - Our capture is 1320x2868 ✅
- **iPad**: 2048x2732 (12.9" display) - Our capture is 2064x2752 ✅
- Min 3, Max 10 per device
- PNG format

## Tips

1. **Clean status bar**: In Simulator, Features > Status Bar > uncheck "Show" options
2. **Landscape iPad**: Cmd+Left/Right arrow to rotate
3. **Onboarding**: Must reset privacy to see first-launch screen again
4. **Open Simulator**: Use `open -a Simulator` if window is hidden
