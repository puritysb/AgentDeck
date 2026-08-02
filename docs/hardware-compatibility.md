---
id: hardware.compatibility
title: Hardware and OS Compatibility
description: Canonical device, panel, transport, host, and App Store compatibility matrix.
category: Specs
locale: en
canonical: true
status: stable
owner: Hardware maintainers
reviewed: 2026-08-02
revision: 2026-08-02
source_of_truth: docs/hardware-compatibility.md
validators: [node scripts/build-design-system-viewer.mjs --check, bash esp32/robot/run.sh all]
translations: [ko, ja]
---

# Hardware and OS Compatibility

This is the source of truth for AgentDeck dashboard surfaces and their compatibility. A **surface** is any hardware, app, or terminal client that connects to the daemon hub and renders or controls agent state.

Reader translations: [한국어](../agentdeck-design-system/locales/ko/hardware-compatibility.md) · [日本語](../agentdeck-design-system/locales/ja/hardware-compatibility.md). English remains canonical; translations carry the same revision and must not introduce new facts.

## Ownership

| Fact | Canonical source |
|---|---|
| Cross-platform device, panel, transport, and compatibility data | This document |
| ESP32 flashing, pins, ports, provisioning, and OTA | [ESP32 operations](esp32.md) |
| Device protocol, discovery, and event handling | [Device transports](devices.md) |
| Android build and e-ink rendering | [Android](android.md) |
| App Store versus CLI feature gates | [App Store feature matrix](appstore-feature-matrix.md) |

Do not copy numeric specifications into domain guides. Link back to this matrix and keep operational detail in the owning guide.

## Support legend

| Mark | Meaning |
|:---:|---|
| Yes | Supported by the App Store Swift daemon or app |
| Partial | Supported with a stated limitation or pending hardware verification |
| CLI | Requires the external Node daemon or a CLI-managed transport |
| Experimental | Registration or firmware is under active development |

## Surface matrix

| Surface | Class | Platform / controller | Display | Transport | App Store |
|---|---|---|---|---|:---:|
| IPS 3.5 | ESP32 display | ESP32-S3 | AXS15231B IPS · 480×320 | USB serial · Wi-Fi WS | Yes |
| Round AMOLED 1.8 | ESP32 display | ESP32-S3 | ST77916 · 360×360 | USB serial · Wi-Fi WS | Yes |
| 86 Box 4.0 | ESP32 display | ESP32-S3 | ST7701 IPS · 480×480 | USB serial · Wi-Fi WS | Yes |
| TTGO T-Display 1.14 | ESP32 display | ESP32 classic | ST7789 · 135×240 | USB serial · Wi-Fi WS | Yes |
| Waveshare LCD 1.47 | ESP32 display | ESP32-C6 | ST7789 · 172×320 | USB serial · Wi-Fi WS | Yes |
| IPS 10.1 | ESP32 display | ESP32-P4 + C6 | JD9365 MIPI-DSI · 800×1280 | USB serial · Wi-Fi WS | Yes |
| T-Embed Companion Knob | ESP32 knob | ESP32-S3 | ST7789 · 320×170 + 8-LED ring | Wi-Fi WS · USB serial | Yes |
| T-Display-S3-Pro Focus Strip | ESP32 strip | ESP32-S3 | ST7796U · 480×222 + touch | Wi-Fi WS · USB serial | Yes |
| Ulanzi TC001 | ESP32 LED | ESP32 classic | WS2812B · 32×8 | USB serial · Wi-Fi WS | Partial |
| InkDeck | ESP32 e-ink | XIAO ESP32-S3 Plus | UC8179 e-ink · 7.5″ · 800×480 | USB serial · Wi-Fi WS | Yes |
| XTeink X3 | e-ink reader | ESP32-C3 | E-ink · 3.7″ · 528×792 | Wi-Fi WS | Partial |
| XTeink X4 | e-ink reader | ESP32-C3 | SSD1677 e-ink · 4.26″ · 480×800 | Wi-Fi WS | Partial |
| Divoom Pixoo64 | Commercial LED | Divoom controller | RGB LED · 64×64 | HTTP REST | Yes |
| iDotMatrix | Commercial pixel display | BLE SoC | RGB · 32×32 | BLE GATT | Yes |
| Divoom Timebox Mini | Commercial LED | BLE SoC | RGB LED · 11×11 | BLE GATT | Yes |
| Ulanzi D200H | HID deck | SigmaStar SSD210 | LCD keys · logical 960×540 | Ulanzi Studio plugin | Yes |
| Stream Deck | HID deck | Elgato | 15 LCD keys · 5×3 | Elgato plugin → WS | Yes |
| Stream Deck Mini | HID deck | Elgato | 6 LCD keys · 3×2 | Elgato plugin → WS | Yes |
| Stream Deck+ | HID deck | Elgato | 8 keys · 4 dials · touch strip | Elgato plugin → WS | Yes |
| Stream Deck XL | HID deck | Elgato | 32 LCD keys · 8×4 | Elgato plugin → WS | Yes |
| Stream Deck + XL | HID deck | Elgato | 36 keys · 9×4 · 6 dials | Elgato plugin → WS | Yes |
| macOS | App | Apple Silicon · Intel | Host display | In-process Swift daemon | Yes |
| iOS / iPadOS | App | A-series · M-series | Device display | Wi-Fi WS | Yes |
| Android e-ink | App | Vendor-specific | B&W or color e-ink | ADB localhost · mDNS | Partial |
| Android tablet | App | ARM · x86 | Color LCD | mDNS · Wi-Fi WS | Partial |
| TUI dashboard | Terminal | Host CPU | Truecolor terminal | WS | Yes |
| SSE stream | Protocol | Host | Browser or script | HTTP `/sse` | Partial |

`App Store` describes compatibility with the submitted Apple app and its Swift daemon, not whether third-party host software is bundled. Stream Deck and D200H still require their vendor applications.

**Counted surfaces: 26.** Public surface-count claims (README, landing page) mirror this derivation: every row above except the protocol rows (SSE stream) counts. XTeink X3/X4 operate normally (both register with the daemon over Wi-Fi) but run the community CrossPoint fork — their Partial mark states that distribution limitation, see operational exceptions. Update this line and the mirrors together when rows change.

## ESP32 board specification sheet

The AgentDeck firmware uses PlatformIO and Arduino. LVGL 9.2 drives LCD boards; TC001 uses FastLED; InkDeck uses its e-ink renderer. USB port names are not identities—probe `device_info_request` before flashing.

Rows are ordered by overall capability, applied in this precedence: SoC class, then memory, then panel capability, then peripheral breadth. Boards of the same character sit together, so the e-ink surfaces run consecutively by diagonal. Three status values appear:

- **Shipping** — runs AgentDeck firmware from `esp32/`, and has a row in the surface matrix above.
- **Community fork** — a counted surface that registers with the daemon and renders normally, but runs the external CrossPoint Reader fork rather than this repository's firmware.
- **Evaluation** — hardware on hand that AgentDeck does not yet build firmware for. These rows are *not* counted as surfaces and carry no compatibility claim; they exist so board selection starts from measured facts rather than vendor copy. No board currently sits here: the last two (T-Embed CC1101, T-Display-S3-Pro) graduated on 2026-07-25/26.

| Board | `device_info.board` · env | SoC | Flash · PSRAM | Display | Controller | Input | Notable peripherals | Host link | OTA slot | Status |
|---|---|---|---|---|---|---|---|---|---:|---|
| JC8012P4A1C | `ips_10` · `ips10` | ESP32-P4NRW32 + C6 | 16 MB · 32 MB | 10.1″ IPS LCD · 800×1280 | JD9365 MIPI-DSI | GSL3680 touch | Front MIPI-CSI 1080p camera (sensor unconfirmed) · ESP32-C6 Wi-Fi coprocessor · ES8311 audio codec (0x18) + speaker (playback verified) · 2× mic (vendor spec, unused) | CH340 USB serial | 6 MB | Shipping |
| ESP32-S3-4848S040 | `86box` · `box_86` | ESP32-S3 | 16 MB · 8 MB | 4.0″ IPS LCD · 480×480 | ST7701 RGB | GT911 touch | — | CH340 USB serial | 7.75 MB | Shipping |
| JC3248W535 | `ips_35` · `ips35` | ESP32-S3 | 16 MB · 8 MB | 3.5″ IPS LCD · 480×320 | AXS15231B QSPI | AXS15231B touch (0x3B) | FAT data partition | Native USB JTAG | 3.5 MB | Shipping |
| LilyGO T-Display-S3-Pro V1.1 · GC0308 | `t_display_pro` · `t_display_pro` | ESP32-S3R8 | 16 MB · 8 MB | 2.33″ IPS LCD · 480×222 | ST7796U SPI | CST226SE touch (0x5A) · 4 physical buttons (BOOT + split rocker are app-readable; RST is hard reset) | GC0308 camera · SY6970 PMU (0x6A) · LTR-553ALS (0x23) · microSD · 470 mAh | Native USB JTAG | 6 MB | Shipping |
| LilyGO T-Display-S3-Pro V1.1 · no camera | `t_display_pro` · `t_display_pro` | ESP32-S3R8 | 16 MB · 8 MB | 2.33″ IPS LCD · 480×222 | ST7796U SPI | CST226SE touch (0x5A) · 4 physical buttons (BOOT + split rocker are app-readable; RST is hard reset) | SY6970 PMU (0x6A) · LTR-553ALS (0x23) · microSD · 470 mAh · camera POGO header | Native USB JTAG | 6 MB | Shipping |
| LilyGO T-Embed CC1101 | `t_embed` · `t_embed` | ESP32-S3-WROOM-1 | 16 MB · 8 MB | 1.9″ IPS LCD · 320×170 | ST7789 SPI | Rotary encoder · button | CC1101 sub-GHz · PN532 NFC (0x24) · IR TX/RX · 8× WS2812 · mic + speaker · BQ25896 (0x6B) · BQ27220 (0x55) · microSD · 1300 mAh | Native USB JTAG | 6 MB | Shipping |
| JC3636W518 | `round_amoled` · `amoled` | ESP32-S3 | 8 MB · 8 MB | 1.8″ round AMOLED · 360×360 | ST77916 QSPI | CST816S touch | — | Native USB JTAG | 3 MB | Shipping |
| Seeed TRMNL 7.5 DIY Kit | `inkdeck` · `inkdeck` | XIAO ESP32-S3 Plus | 8 MB · 8 MB | 7.5″ e-ink 1-bit · 800×480 | UC8179 | — | USB-powered only | Native USB CDC | 3.19 MB | Shipping |
| XTeink X4 | `xteink_x4` · external fork | ESP32-C3 | 16 MB · none | 4.26″ e-ink · 480×800 portrait | SSD1677 | Page buttons | microSD · 650 mAh | Wi-Fi only | Wi-Fi OTA · SD `update.bin` | Community fork |
| XTeink X3 | `xteink_x3` · external fork | ESP32-C3 | 16 MB · none | 3.7″ e-ink · 528×792 portrait | — | Page buttons | I2C IMU (runtime model detect) · NFC · microSD · battery | Wi-Fi only | Wi-Fi OTA · SD `update.bin` | Community fork |
| Waveshare ESP32-C6-LCD-1.47 | `esp32_c6_147` · `esp32_c6_147` | ESP32-C6 | 4 MB · none | 1.47″ IPS LCD · 172×320 | ST7789 | — | — | Native USB CDC | Single app | Shipping |
| LilyGO T-Display | `ttgo_t_display` · `ttgo` | ESP32 classic | 16 MB · none | 1.14″ IPS LCD · 135×240 | ST7789 SPI | 2 buttons | — | CH340 USB serial | 6 MB | Shipping |
| Ulanzi TC001 | `ulanzi_tc001` · `led8x32` | ESP32 classic | 8 MB · none | WS2812B LED matrix · 32×8 | WS2812B | 3 buttons | Buzzer on GPIO 15 (silenced at boot) | CH340 USB serial | 3 MB | Shipping |

The ordering is by panel and compute, so peripheral breadth does not drive it. On that separate axis the T-Embed CC1101 leads every board here: it is the only unit with a rotary encoder, and the only one carrying a sub-GHz radio, NFC, and infrared. Since 2026-07-25 it ships as the **Companion Knob** — the fleet's first bidirectional-input board. Encoder steering, portable pager/chime, fuel gauge, NFC, IR receive, push-to-talk, host transcription, and spoken replies are implemented; BLE phone relay and CC1101 sub-GHz capture remain future phases. The role and implementation record is in [ESP32 companion concepts](esp32-companion-concepts.md).

The XTeink readers are ESP32 boards and belong in this sheet, but they are the only rows AgentDeck neither builds nor flashes: one CrossPoint fork binary serves both models and picks `xteink_x3` or `xteink_x4` at runtime from an I2C IMU fingerprint. They reach the daemon over Wi-Fi only — there is no USB-serial path. Since fork build 88aaf098 (2026-07-26, X4 hardware-verified) they implement AgentDeck WiFi OTA v1: `agentdeck esp32-ota xteink_x4 --firmware <bin>` streams chunks to an SD cache which is validated and then raw-partition-flashed (the fork never uses the Arduino `Update` class — X4 silicon rejects the patched image through `esp_image_verify`); the SD-card `update.bin` flow remains the recovery/bootstrap fallback. Both are portrait in device coordinates: the X4 panel is quoted 800×480 on its datasheet (long axis first) but the firmware declares it 480×800, and CrossPoint boots portrait with orientation left as a user setting.

OTA slot sizes are the measured `device_info.otaSlotSize` from live boards, matching `esp32/partitions/*.csv`. The T-Display-S3-Pro shipped with a single-app 4 MB factory table; its first USB flash migrates it to the 16 MB dual-OTA layout, after which it updates over Wi-Fi like every other board. Factory images and restore instructions — including the captured S3-Pro and T-Embed images — live in [`esp32/backups/MANIFEST.md`](../esp32/backups/MANIFEST.md).

Operational exceptions:

- `box_86` is the 86 Box environment and the `default_envs` target. The former `rgb48` duplicate — a LovyanGFX build on espressif32@6.9.0 — was removed on 2026-07-20 when the board consolidated onto the pioarduino/Arduino_GFX stack the other S3 boards use.
- TTGO flashing uses 57,600 baud with `--no-stub`; its no-PSRAM renderer has a deliberately small buffer.
- IPS 10.1 uses a 16 MB dual-OTA layout with 6 MB slots and requires internal-memory LVGL buffers. Its ESP32-C6 is the Wi-Fi coprocessor.
- Existing factory or old-partition 86 Box and IPS 10.1 units require one USB full flash before OTA.
- InkDeck serial reflashing must go through the download-mode port with `boot_app0.bin` included (native-CDC re-enumeration makes plain `pio -t upload` unreliable); routine updates ship over WiFi OTA instead. A residual crash in the prebuilt Espressif mDNS component is under observation and does not affect the render or OTA path.
- XTeink X3/X4 run the external CrossPoint Reader fork, not the `esp32/` PlatformIO project. They are not distributed through AgentDeck releases; routine updates ship over WiFi OTA (`agentdeck esp32-ota xteink_x4 --firmware <bin>` — the fork firmware is built in its own repo, so `--build` does not apply) with SD-card `update.bin` as the bootstrap/recovery path. Their wire contract is [ESP32 client contract](esp32-client-contract.md).
- T-Display-S3-Pro ships in hardware revisions V1.0 and V1.1 that differ in backlight drive, with no runtime detection — the vendor selects it at compile time with `USING_DISPLAY_PRO_V1`. V1.0 is LEDC PWM with 255 levels; V1.1 is a constant-current driver pulsed on GPIO 48 with 16 levels. Both on-hand units are V1.1, so that flag must stay undefined for them. The vendor `platformio.ini` comment on this flag has its two revisions transposed; the `#ifdef` branches in `AdjustBacklight.ino` and `utilities.h` are authoritative.
- T-Display-S3-Pro camera is a purchase option (`GC0308`, `OV5640`, or none) on a POGO shield header, not a board revision — and it faces **backward** (away from the user), which is why its role is show-and-tell capture, not presence. Its SCCB lines share the I2C bus with touch, PMU, and the light sensor; SCCB traffic is init-time only (pixel data rides the dedicated DVP pins), so the practical contention window is camera bring-up, not streaming. The on-hand shield is the GC0308: VGA-class and fixed-focus, fine for whiteboards/layouts/error dialogs, not for reading code off a monitor — the OV5640 (5 MP, autofocus) drops into the same header when that matters.
- **JC8012P4A1C touch-controller startup is restored under AgentDeck firmware.** On-device verification now reads all 132 volatile GSL3680 firmware pages back with zero mismatches and then observes the controller's standard running marker, `0xB0 = 0x5A5A5A5A` (previously always zero). The root cause was a vendor-derived clear sequence that wrote `0x88 = 0x01`; `0x80` is the Silead touch-count register, and writing `0x80 = 3` is what actually enables this panel's scan core. The driver also uses the ESP-IDF I2C master directly at the board's 400 kHz rate, retries failed writes, validates four-byte page selection, and never publishes a freed handle after initialization failure. The IPS10 LVGL/PPA slice is 16 lines so the three internal DMA buffers leave enough contiguous SRAM for ESP-Hosted; the corrected firmware ran for more than 120 seconds without the former SDIO allocation reset. Physical touch and the landscape interaction path are operator-confirmed on the flashed unit.
- JC8012P4A1C carries a **front-facing MIPI-CSI camera** ("MIPI CSI 1080P" per the vendor manual; the sensor part is not documented — community reports disagree between SC2336 and OV02C10, and the ESPHome/Tasmota communities have no working driver yet, so confirming it needs an on-device SCCB probe). The vendor sheet also lists dual microphones and a speaker. On 2026-07-27 an on-device I2C probe (`{"type":"i2c_diag"}`, `esp32/src/ui/display.cpp`) **confirmed the ES8311 audio codec at 0x18** on the touch bus (`I2C_NUM_1`, SDA 7 / SCL 8): chip-ID registers `0xFD`/`0xFE` read `0x83`/`0x11`, version `0x01`, ACK stable 5/5, and the register file reads back at its reset defaults — a codec nothing has configured. The same sweep found two undocumented devices at **0x32** and **0x36** (0x36 is a common camera-SCCB and fuel-gauge address; both are unidentified here). Playback landed the same day and is hardware-verified: the panel plays 16 kHz mono PCM16 through the codec, driven by the shared `speaker_playback` module. Pins come from the board's own ESP-IDF BSP (`bsp_jc8012p4a1c`) — I2S MCLK 13 / BCLK 12 / LRCK 10 / DOUT 9, power amplifier enable **GPIO 20**, mic in on 11. Two constraints are worth carrying: the I2S channel is claimed during display init, ahead of the LVGL draw buffer, because its DMA descriptors need internal RAM that the forced-internal LVGL buffer and the ESP-Hosted WiFi stack also draw from (a late claim returns `ESP_ERR_NO_MEM` and can assert the SDIO driver); and the board is intentionally dual-home while USB is attached. Its CH340 really runs at 115200 baud (~11 KB/s payload), while 16 kHz PCM16 wrapped in serial JSON/base64 needs ~43 KB/s, so serial remains the deduplicated state path and the hosted-C6 WebSocket carries microphone and speaker audio. Push-to-talk capture is built through `BOARD_HAS_VOICE_CAPTURE`; `BOARD_HAS_AUDIO` stays `0` because that separate flag gates the dormant on-device wake-word path. Voice-result UI state crosses from the network core through a fixed-size handoff and is applied only by `HUD::update()` on the LVGL/UI core. The ESP32-P4 is the only SoC in the fleet with a hardware ISP + MIPI-CSI, which makes this unit the natural candidate for on-device presence detection (boolean only, frames never leave the board) — recorded as a future phase in [ESP32 companion concepts](esp32-companion-concepts.md).
- T-Embed CC1101 has a known upstream defect where the panel stays dark after flashing; the vendor ships a dedicated fix image and advises pressing `RST` on the back afterwards. Check this before diagnosing a hardware fault.
- Steering from the T-Embed knob and the T-Display-S3-Pro strip is hardware-verified against both daemons: the session-scoped `select_option` / `session_command` round-trip on Node, and on Swift the truncated-id resolver plus the session-scoped command guard (a device echo of a 31-char id reached the observed branch while the OpenClaw gateway was connected). Answering a *live, unheld* terminal prompt from a device needs terminal injection and is CLI-daemon only — see [App Store feature matrix](appstore-feature-matrix.md).
- T-Display-S3-Pro V1.1 backlight is a pulse-stepped constant-current driver (16 levels on GPIO 48), ported verbatim from the vendor `AdjustBacklight.ino`; the LTR-553 ambient sensor drives a local three-band dim curve composed with the host display-sleep contract. Its USB CDC corrupts esptool streams at high baud — the `t_display_pro` env pins stub uploads at 230400 (and 16 MB `read-flash` captures need the same rate: 460800 reads died mid-stream on the camera unit).
- T-Display-S3-Pro WiFi joins are power-fenced (2026-07-27): a STA join concurrent with display bring-up browned out the camera unit's 3.3 V rail on Mac-USB power and became a self-sustaining reboot loop (`E BOD`), because every reboot retried the join. The firmware ladder: boot never joins (radio off), `wifi_provision` over live serial saves credentials without joining (IPS10 pattern; the saved store also flips `wifiConfigured` so the daemon stops re-provisioning), the deferred join runs ~25 s after boot — restoring the fleet's normal dual-home (serial primary + WS standby), which the photo path needs because HWCDC 64-byte FIFO holes tear large serial lines — and a brownout-reset boot suppresses auto-join entirely. An idle-time join on the same supply succeeds — only the boot-concurrent join was fatal.

## Pixel displays and control decks

| Device | Rendering / ownership constraint |
|---|---|
| Pixoo64 | LAN HTTP REST; no supported raw-frame BLE path. AgentDeck throttles frame pushes and recovers from device-side timeouts. |
| iDotMatrix | Native 32×32 composition over BLE. The daemon owns one BLE display connection at a time. |
| Timebox Mini | Dedicated 11×11 Agent Beacon over ISSC BLE GATT. It shares the single BLE connection budget with iDotMatrix. |
| TC001 | Self-rendering serial/Wi-Fi board. App Store status is Partial only because the Swift `led8x32` path awaits hardware verification; this is not a sandbox restriction. |
| D200H | Ulanzi Studio plugin is the only driver. Direct-HID implementations are retired. |
| Stream Deck family | One plugin provides bundled profiles for standard (DeviceType 0), Mini (1), XL (2), Plus (7), and + XL (13). The XL and + XL profiles AutoInstall and auto-switch on connect like the others; the + XL uses its 6 dials (4 assigned, E5–E6 unassigned). |

## Software platforms

| Platform | Minimum / toolchain | Connection model | Constraint |
|---|---|---|---|
| macOS | macOS 26 · Xcode 26.6 · Swift 6 | In-process Swift daemon on port 9120 | App Store sandbox; no subprocesses or bundled interpreter |
| iOS / iPadOS | iOS 17 · Swift 6 | Bonjour + same-LAN WS | Client only; no direct hardware modules |
| Android | minSdk 29 · target/compileSdk 34 · JDK 17 | ADB localhost first, then mDNS | ADB reverse is CLI-only; same-LAN discovery is sandbox-safe |
| Node bridge | Node.js 22+ | Daemon on port 9120 | Supported on macOS and Windows 11; Linux is not an official host |

Android e-ink uses vendor-native refresh controls: Crema and MOAAN use `EinkManager`, Onyx uses its update-mode API, Bigme uses a color palette path, and Kobo falls back to invalidation. Android and Apple share the wire protocol; their render and discovery layers remain platform-native.

## Protocol surfaces

| Surface | Contract | Limitation |
|---|---|---|
| TUI | WS client, truecolor ANSI, responsive at 60/80/120 columns | Push-only view |
| SSE | `GET /sse` on daemon port 9120 | Full streaming and heartbeats exist in the Node bridge. The Swift daemon currently sends only the initial `connected` event. |

## Change checklist

1. Update the owning row here before changing a public device count or compatibility claim.
2. Update the domain guide only for operational behavior; do not duplicate specifications.
3. Update the matching KR and JP translation revision without adding translation-only facts.
4. Run the frontmatter/catalog validator and the relevant runtime or hardware suite.
5. Keep the GitHub Pages viewer generated from these sources; never hand-edit generated viewer content.
