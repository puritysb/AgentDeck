---
name: agentdeck-deploy
description: Build, install, launch, and configure AgentDeck on connected Android, Apple, ESP32, Stream Deck, or daemon targets. Use when the user asks to deploy AgentDeck or names target devices such as pantone, crema, lenovo, iphone, ipad, macos, esp32, tc001, bridge, daemon, or plugin.
---

# AgentDeck Deploy

Canonical deploy procedure for AgentDeck. This file is the single source of truth — `.claude/skills/deploy.md` is a thin pointer to it. Build, install, launch, and configure AgentDeck on connected targets; keep deployment scoped to what is actually connected and skip missing devices with a clear note (never fail the whole deploy because one device is absent).

## Arguments / Target Names

Parse the argument string to determine target(s). Multiple targets can be combined (e.g. `android ios`).

| Argument | Scope |
|----------|-------|
| (none) / `all` | Full deploy: bridge → plugin → android → ios → macos |
| `android` | All connected Android devices |
| `pantone` / `pantone6` | Pantone 6 only |
| `crema` | Crema S only |
| `lenovo` / `tablet` / `tab` | Lenovo Tab only |
| `ios` | All iOS devices (iPad + iPhone) |
| `iphone` | iPhone 14 Pro Max only |
| `ipad` | iPad Air M2 only |
| `macos` / `mac` | macOS app only |
| `apple` | iOS + macOS |
| `esp32` | All connected ESP32 boards (LVGL only — excludes Ulanzi TC001) |
| `esp32-all` | All ESP32 boards including Ulanzi TC001 |
| `ulanzi` / `tc001` | Ulanzi TC001 LED matrix only |
| `bridge` / `daemon` | Daemon restart only |
| `plugin` / `sd` | Stream Deck plugin only |

## Device Registry

### Android Devices

| Device | Serial | Type | Quirks |
|--------|--------|------|--------|
| **Pantone 6** | `AA007422R24C1300039` | Color e-ink (Kaleido 3, RK3566) | Rotation reset on reinstall → must restore landscape. WRITE_SETTINGS permission lost on reinstall |
| **Crema S** | `CREMAA21W09235` | B&W e-ink (RK3566) | Standard |
| **Lenovo Tab** | `HVA095B4` | LCD tablet (J606F) | Standard |

### Apple Devices

| Device | devicectl ID | xcodebuild destination | Type |
|--------|-------------|----------------------|------|
| **iPad Air 11" (M2)** | `8B71247D-A740-535E-8B2C-6FE9A196F342` | `platform=iOS,id=00008112-001608A02ED2601E` | WiFi/USB |
| **iPhone 14 Pro Max** | `7F0EF7A8-CB34-570E-9F26-19B574A72703` | `platform=iOS,id=00008120-001169AA11D8C01E` | USB |
| **macOS** | — | `platform=macOS` | Local |

### ESP32 Boards

> **두 이름 층** (panel/form + 인치): `friendly` 는 `./scripts/flash.sh <friendly>` 에 넘기는 canonical 친근명, `pio env` 는 `pio run -e <pio env>` / `.pio/build/<pio env>/` 에 쓰는 실제 PlatformIO env. flash.sh 는 둘 다 받지만 `pio run -e` 는 **pio env 만** 받는다.

| Board | friendly (flash.sh) | pio env (pio run -e) | Serial Pattern | Chip |
|-------|------------|------------|----------------|------|
| **86 Box** (480×480) | `box_40` | `box_86` | `/dev/cu.usbserial-*` | ESP32-S3, CH340 |
| **IPS 3.5"** (480×320) | `ips_35` | `ips35` | `/dev/cu.usbmodem*` | ESP32-S3, native USB |
| **Round AMOLED** (360×360) | `amoled_18` | `amoled` | `/dev/cu.usbmodem*` | ESP32-S3, native USB |
| **TTGO T-Display** (135×240) | `tft_114` | `ttgo` | `/dev/cu.wchusbserial*` | ESP32-D0WDQ6, CH340 |
| **ESP32-C6** (172×320) | `c6_147` | `esp32_c6_147` | `/dev/cu.usbmodem*` | ESP32-C6, native USB CDC |
| **IPS 10.1"** (800×1280) | `ips_101` | `ips10` | `/dev/cu.wchusbserial*` | ESP32-P4 + C6 |
| **Ulanzi TC001** (8×32 LED) | `led_8x32` | `led8x32` | `/dev/cu.usbserial-*` | ESP32-D0WD classic, CH340 |

## Execution Steps

### Step 0: Pre-flight — Detect Connected Devices

Run before any deploy to know what's available:

```bash
cd /Users/puritysb/github/AgentDeck

echo "=== ADB Devices ==="
adb devices -l 2>/dev/null | grep -w device | grep -v "List"

echo "=== Apple Devices ==="
xcrun devicectl list devices 2>/dev/null | grep -E "(iPhone|iPad)" || echo "none"

echo "=== Serial Ports (ESP32) ==="
ls /dev/cu.usb* 2>/dev/null || echo "none"

echo "=== Stream Deck ==="
pgrep -x "Stream Deck" >/dev/null && echo "running" || echo "not running"

echo "=== Daemon ==="
cat ~/.agentdeck/daemon.json 2>/dev/null || echo "not running"
```

Only deploy to devices that are actually connected. Skip missing devices with a warning, don't fail. If any preflight command fails because of sandboxing or device access, request scoped approval and retry only that command — do not guess.

### Step 1: Build (always first, unless target is bridge-only or esp32-only)

```bash
cd /Users/puritysb/github/AgentDeck
pnpm build
```

For Android targets, also build APK:
```bash
bash scripts/build-android-release.sh
```
This produces `dist/agentdeck-v{VERSION}.apk`.

For Apple targets (ios/macos), build via xcodebuild (see Step 3/4).

### Step 2: Android Deploy

For EACH connected Android device in the target set:

```bash
SERIAL="<device_serial>"
APK="dist/agentdeck-v*.apk"  # use the actual versioned filename from Step 1

# 1. Stop running app
adb -s $SERIAL shell am force-stop dev.agentdeck

# 2. Install (attempt direct first, uninstall on signature conflict)
if ! adb -s $SERIAL install -r $APK 2>&1 | grep -q "Success"; then
  adb -s $SERIAL uninstall dev.agentdeck
  adb -s $SERIAL install $APK
fi

# 3. Launch
adb -s $SERIAL shell am start -n dev.agentdeck/.MainActivity

# 4. adb reverse for daemon connection
adb -s $SERIAL reverse tcp:9120 tcp:9120
```

**Device-specific post-install:**

**Pantone 6** (after ANY install, especially after uninstall→reinstall):
```bash
# Rotation fix — reinstall resets system rotation settings
adb -s AA007422R24C1300039 shell settings put system accelerometer_rotation 0
adb -s AA007422R24C1300039 shell settings put system user_rotation 1  # 1=landscape
```

**Crema S**: No special steps needed.

**Lenovo Tab**: No special steps needed.

### Step 3: iOS Deploy

Build once, install on multiple devices:

```bash
cd /Users/puritysb/github/AgentDeck/apple

# Build (one build serves both devices)
xcodebuild build -project AgentDeck.xcodeproj -scheme AgentDeck_iOS \
  -destination 'platform=iOS,id=00008112-001608A02ED2601E' \
  CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=R22679GY5Z -quiet

APP=~/Library/Developer/Xcode/DerivedData/AgentDeck-dqyrhbwpqboxgiabhllzxkkjxqzy/Build/Products/Debug-iphoneos/AgentDeck.app
```

For EACH iOS device in the target set:
```bash
DEVICE_ID="<devicectl_id>"
xcrun devicectl device install app --device $DEVICE_ID $APP
xcrun devicectl device process launch --device $DEVICE_ID bound.serendipity.agent.deck
```

**Important:**
- Devices must be unlocked (passcode protected → install fails)
- After uninstall→reinstall, local network permission popup appears again
- Prefer existing XcodeBuildMCP tools when available; otherwise use these established `xcodebuild` commands

### Step 4: macOS Deploy

```bash
cd /Users/puritysb/github/AgentDeck/apple
xcodebuild build -project AgentDeck.xcodeproj -scheme AgentDeck_macOS \
  -destination 'platform=macOS' -quiet

# Kill existing → relaunch
killall AgentDeck 2>/dev/null; sleep 0.5
open -a "/Users/puritysb/Library/Developer/Xcode/DerivedData/AgentDeck-dqyrhbwpqboxgiabhllzxkkjxqzy/Build/Products/Debug/AgentDeck.app"
```

Do not add or alter App Store UI text that asks users to install or launch external tools (App Review 4.2.3 — see `CLAUDE.md` "App Store build invariants").

### Step 5: Bridge/Daemon Restart

```bash
agentdeck daemon stop 2>/dev/null
sleep 1
agentdeck daemon start &
sleep 2
agentdeck daemon status
```

### Step 6: Plugin

If Stream Deck is running and plugin is linked (`streamdeck link`), `pnpm build` (Step 1) is sufficient.

For fresh install:
```bash
cd /Users/puritysb/github/AgentDeck
pnpm package
# Output: dist/bound.serendipity.agentdeck.streamDeckPlugin
# User must drag into Stream Deck app manually
```

### Step 7: ESP32 Firmware

**CRITICAL: Build and flash ONE AT A TIME** — PlatformIO lock + serial port conflicts.

**Ulanzi TC001 is a separate target.** The `esp32` target deploys LVGL boards only (86 Box, IPS 3.5", Round AMOLED). Use `ulanzi`, `tc001`, or `esp32-all` to include the Ulanzi TC001. This separation exists because:
- Ulanzi uses a different chip (ESP32-D0WD classic vs ESP32-S3)
- Ulanzi uses FastLED matrix rendering, not LVGL — UI changes to cloud.cpp/theme.h don't affect it
- Ulanzi requires a different flash procedure (esptool full-flash vs PIO upload)

**CRITICAL: Identify boards by `device_info` BEFORE flashing.** Port numbers change when USB hub positions change — never assume a port number means a specific board.

```bash
cd /Users/puritysb/github/AgentDeck/esp32

# Step 1: Detect and IDENTIFY each board
for port in /dev/cu.usb*; do
  echo "=== $port ==="
  # Send device_info_request, read 1 line with timeout
  (echo '{"type":"device_info_request"}' > "$port" &) 2>/dev/null
  timeout 2 head -1 < "$port" 2>/dev/null | grep -o '"board":"[^"]*"' || echo "no response"
done
# Match each port to its board name before flashing!
```

If the daemon is holding a serial port, stop the daemon (or use the flash helper that pauses/resumes it) before flashing — see `docs/esp32.md`.

#### LVGL Boards (86 Box, IPS 3.5", Round AMOLED)

Flash each detected LVGL board:
```bash
# Match port to environment and flash
pio run -e <environment> -t upload --upload-port <port>
```

**86 Box CH340 fallback**: If PIO upload fails at high baud (chip stops responding), build separately then flash with esptool at 115200:
```bash
pio run -e box_86  # build only
~/.platformio/penv/bin/esptool --chip esp32s3 --port <port> --baud 115200 \
  --before default-reset --after hard-reset write-flash -z \
  --flash-mode dio --flash-freq 80m --flash-size 8MB \
  0x0 .pio/build/box_86/bootloader.bin \
  0x8000 .pio/build/box_86/partitions.bin \
  0x10000 .pio/build/box_86/firmware.bin
```

After flash: USB re-plug required for JTAG boards (IPS 3.5", Round AMOLED).

#### Ulanzi TC001 (separate target)

**Only flash when `ulanzi`, `tc001`, or `esp32-all` is specified.** Skip for plain `esp32` target.

Use the helper script or the equivalent `esptool` command at `115200`:
```bash
cd /Users/puritysb/github/AgentDeck/esp32
./scripts/flash.sh led_8x32 /dev/cu.usbserial-211110
```

Equivalent manual fallback:
```bash
cd /Users/puritysb/github/AgentDeck/esp32
~/.platformio/penv/bin/esptool --chip esp32 --port /dev/cu.usbserial-211110 --baud 115200 \
  --before default-reset --after hard-reset write-flash -z \
  --flash-mode dio --flash-freq 40m --flash-size 8MB \
  0x1000 .pio/build/led8x32/bootloader.bin \
  0x8000 .pio/build/led8x32/partitions.bin \
  0x10000 .pio/build/led8x32/firmware.bin
```

Notes:
- `460800` is not reliable on the TC001's CH340 path
- always flash `bootloader + partitions + firmware` together
- if the daemon is holding the serial port, the helper script pauses it and resumes it after flash

## Verification

After all deploys complete, verify each target:

```bash
# Android: check process running
for d in AA007422R24C1300039 CREMAA21W09235 HVA095B4; do
  adb -s $d shell pidof dev.agentdeck 2>/dev/null && echo "$d: running" || echo "$d: not running"
done

# Daemon
curl -s http://localhost:9120/health | head -1

# Plugin / Devices
agentdeck devices 2>/dev/null
```

## Output

Print a summary table at the end. Example:

```
Deploy Summary
══════════════════════════════════════════════════
 Target          Status   Details
──────────────────────────────────────────────────
 Bridge           OK      Daemon port 9120
 Plugin           OK      Built, SD running
 Pantone 6        OK      Installed + launched + rotation fix
 Crema S          OK      Installed + launched
 Lenovo Tab       OK      Installed + launched
 iPad Air         OK      Installed + launched
 iPhone           SKIP    Not connected
 macOS            OK      Built + launched
 ESP32            SKIP    No firmware changes
══════════════════════════════════════════════════
```

Use SKIP (not connected / not in target), OK (success), FAIL (error with reason). Always report which commands required approval.

## Error Handling

- **Signature mismatch**: Auto-uninstall → reinstall. Warn user that app data is lost
- **Device not connected**: SKIP with warning, don't fail the whole deploy
- **Build failure**: Stop immediately, show error. Don't install stale APK
- **iOS device locked**: Warn "device must be unlocked" and skip
- **ESP32 upload hang**: Kill after 60s timeout, suggest esptool fallback
