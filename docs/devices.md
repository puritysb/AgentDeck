---
id: spec.devices
title: Device Catalog
description: Per-device behaviour for every supported dashboard surface — panels, transports, and rendering specifics.
category: Specs
locale: en
canonical: true
status: stable
owner: Device maintainers
reviewed: 2026-08-05
revision: 2026-08-05
source_of_truth: docs/devices.md
validators: [pnpm design-system:check]
---
# AgentDeck Dashboard Devices

대시보드 디바이스 + 프로토콜 종합 레퍼런스 (전송/디스커버리/이벤트 중심). 하드웨어/OS 사양 전체 인벤토리는 [hardware-compatibility.md](hardware-compatibility.md) 가 SSOT.

## Device Matrix

| Device | Transport | Port | Auth | Discovery | Direction | Events |
|--------|-----------|------|------|-----------|-----------|--------|
| **Stream Deck+** | WebSocket JSON | Daemon (9120) | Token (local bypass) | `daemon.json` / mDNS | Bidirectional | All 13 |
| **Android** | WebSocket + HTTP | Daemon (9120) | Token (local bypass) | mDNS / ADB / QR | Bidirectional | All 13 |
| **Apple** | WebSocket + HTTP | Daemon (9120) | Token | mDNS / QR | Bidirectional | All 13 |
| **ESP32** | USB Serial JSON + WiFi WebSocket | CDC/UART 115200 / Daemon (9120) | None | Port scan 10s / mDNS | Push + OTA control | 6 + OTA ack/error |
| **T-Embed Companion Knob** | USB Serial JSON + WiFi WebSocket | CDC 115200 / Daemon (9120) | None | Port scan 10s / mDNS | Bidirectional (encoder steering + voice) | 6 + OTA ack/error + steering/voice uplink |
| **T-Display-S3-Pro Focus Strip** | USB Serial JSON + WiFi WebSocket | CDC 230400 / Daemon (9120) | None | Port scan 10s / mDNS | Bidirectional (touch steering) | 6 + OTA ack/error + steering uplink |
| **Pixoo64** | HTTP REST (Divoom) | LAN:80 | None | Cloud API / manual | Push only | 4 |
| **Timebox Mini** | BLE GATT (ISSC transparent-UART) | `49535343-…` | Bluetooth pairing | `TimeBox-mini-light` BLE scan | Push only | 4 |
| **InkDeck e-ink** | WebSocket JSON (WiFi) | Daemon (9120) | None | mDNS / port scan | Push + OTA control | dashboard frame + OTA ack/error |
| **XTeink X3 / X4** (community fork) | WiFi WebSocket (+ UDP 9121 fallback) | Daemon (9120) | None | mDNS / UDP broadcast | Push + steering (M2) | state/sessions/usage subset; registers via `client_register`(eink-device, macOS) + `device_info`(esp32-wifi, Node) |
| **SSE** | HTTP SSE | Daemon (9120) | Token | Manual URL | Push only | All 13 |
| **Gateway** | WebSocket Custom | 18789 | Ed25519 | Hardcoded | Bidirectional | N/A (adapter) |

> **Daemon hub**: All dashboard clients connect exclusively to the daemon. Session bridges handle PTY + hooks only and do not serve external devices. Daemon port defaults to 9120; if occupied by non-daemon process, daemon falls back to next available port and records actual port in `~/.agentdeck/daemon.json`. Local clients read `daemon.json`; remote clients discover via mDNS (daemon only advertises `_agentdeck._tcp`).

## T-Embed CC1101 (Companion Knob)

**Shipping since 2026-07-25.** The LilyGO T-Embed CC1101 is the fleet's only board with a **rotary encoder**, and the only one you steer with rather than only read from — every other Shipping board is output-only apart from touch. Its UI (`esp32/src/ui/knob/`) is the Stream Deck's session-centric two-level grammar translated to an encoder: at list level rotate cycles sessions and press enters; at detail level rotate moves the option/command cursor, press commits (`select_option` / state command), and long-press backs out (`session_command{escape}`). Holding the encoder is push-to-talk — the board captures voice, the host transcribes, and the reply is spoken back through the board speaker.

It is a **dual-mode companion**: USB-powered on the desk it is a steering knob; on its 1300 mAh cell it becomes a carry-around pager that chimes when a session starts waiting. The 8× WS2812 ring is a session-status ring (one LED per session, up to eight). The BQ27220 fuel gauge gives it a real state-of-charge readout rather than an inferred one.

Peripheral breadth is the widest in the fleet — CC1101 sub-GHz, PN532 NFC, IR TX/RX, mic + speaker, microSD. NFC and IR receive are implemented; **BLE phone relay and CC1101 sub-GHz capture remain future work**. Design record and interaction grammar: [esp32-companion-concepts.md](esp32-companion-concepts.md).

## T-Display-S3-Pro (Focus Strip / Pocket)

**Shipping since 2026-07-26.** The LilyGO T-Display-S3-Pro V1.1 is a 2.33″ 480×222 touch strip. **One firmware serves two physically different units**, and it picks its own personality at boot: `Camera::init()` probes the rear POGO camera shield, and a unit that has one comes up **portrait** in the Pocket UI while a unit that does not comes up **landscape** in the Ticker UI (`esp32/src/main.cpp`). The camera is a purchase option on a shield header — not a board revision — so both units report the same `device_info.board` of `t_display_pro` and take the same OTA image.

- **Landscape (Ticker, no camera)** — three pages: **Focus** (one prioritized session and one readable thought; an awaiting session owns the page and renders separate labelled Deny/Approve targets, so a generic tap can never answer a gate), **Usage** (Claude and Codex quota windows as full-height gauges with reset countdowns — the permanent large-format version of the Stream Deck E2/E3 dials), and **Sessions** (the three highest-value rows). The split rocker moves between pages, `BOOT` returns to Focus, and touch mirrors both with header tabs and swipes.
- **Portrait (Pocket, camera unit)** — a phone-shaped stack of **SESSIONS** (momentum-scrolled cards, tap to focus), **CAM** (upright viewfinder with SNAP and LED; tapping the target line cycles which session receives the photo), and **USAGE**. The whole hardware stack is portrait-native — panel GRAM, CST226SE touch reporting, and camera mounting — so this orientation needs no rotation fights and LVGL's pointer indev drives real widgets instead of hand-rolled gestures.

The **LTR-553 ambient light sensor** makes this the first board where the display-sleep contract takes a sensor input: brightness follows room light and the strip dims itself at night, decided locally. The SY6970 charger has no coulomb-counting register, so the header reports sampled **cell voltage** and charge state rather than an invented percentage.

Two operational constraints are load-bearing and documented in [hardware-compatibility.md](hardware-compatibility.md#esp32-board-specification-sheet): its USB CDC corrupts esptool streams above 230400 baud, and a WiFi join concurrent with display bring-up browns out the camera unit's 3.3 V rail — so the firmware never joins at boot and defers the join by ~25 s.

## InkDeck e-ink (custom firmware)

**InkDeck** is AgentDeck's wired 7.5" e-ink status panel. The hardware is a **Seeed TRMNL 7.5" OG DIY Kit** — a **XIAO ESP32-S3 Plus** wired to an 800×480 monochrome ePaper panel (GDEY075T7 / UC8179 controller), always **USB-powered** (no battery / deep-sleep).

**Status: hardware-verified, shipping via WiFi OTA.** InkDeck is driven by custom AgentDeck ESP32 firmware under `esp32/` (PlatformIO env `inkdeck`). Both transports are implemented and verified on hardware: **USB serial** (TinyUSB CDC) and **WiFi WebSocket** (`device_info` on connect, daemon state push, OTA capability like the other directly flashed boards). Node and Swift daemons both register it, and routine updates deploy over WiFi OTA (`agentdeck esp32-ota inkdeck`). The dashboard UI — session cards, usage footer, timeline strip, partial/full refresh policy — has been through repeated on-device validation rounds. Residual operational caveats: serial reflashing must use the download-mode port with `boot_app0.bin` included (native-CDC re-enumeration breaks plain `pio -t upload`), and a crash in the prebuilt Espressif mDNS component is under observation (does not affect rendering or OTA).

**Display-sleep policy:** InkDeck keeps its dashboard visible when the host Mac's displays sleep or are turned off with a keyboard shortcut. Unlike LCD/OLED/LED devices, its e-ink image needs no panel refresh power to remain visible, and InkDeck is already continuously USB-powered. The firmware therefore ignores `display_state.displayOn` for rendering while continuing to receive and draw meaningful dashboard changes whenever the Mac itself remains awake.

**Responsive dashboard:** the direct GxEPD2 renderer consumes the allocation-free layout model in `esp32/src/ui/eink/eink_dashboard_layout.h`. It derives header, card grid, usage, recent-activity, and control bands from the panel dimensions instead of 800×480 constants; the hardware-specific font/glyph/panel refresh code stays in `eink_display.cpp`.

**Formerly "TRMNL" (BYOS pull) — removed.** AgentDeck previously drove this same physical panel through TRMNL's commercial **BYOS** (Bring Your Own Server) pull contract, where the panel polled `/api/setup` + `/api/display` and downloaded a server-rendered PNG. That integration was **removed** (Node commit `c71044bd`; the App Store Swift `Trmnl*` modules removed alongside). Stock / commercial TRMNL panels running the upstream `usetrmnl/firmware` are **no longer supported** — InkDeck reflashes the same hardware with AgentDeck firmware and treats it as a first-class ESP32 board.

## XTeink X3 / X4 (external-fork client)

**XTeink X3 and X4** are ESP32-C3 e-ink readers driven **not** by AgentDeck's own `esp32/` firmware but by an external **CrossPoint Reader fork** (`crosspoint-agentdeck`, AgentDeck stack on default branch `master`). Its `src/agentdeck/` module is a hand-port of AgentDeck's wire client that renders a "Decision Card" — live agent state + usage, with button-based approve/deny — over the same **WiFi WebSocket** LAN path as other ESP32 boards (plus a UDP-broadcast discovery fallback on 9121). **One firmware** auto-detects the model at runtime (`gpio.deviceIsX3()`, via an I2C IMU fingerprint) and reports the board string `xteink_x3` or `xteink_x4`. No subprocess, so it is not a sandbox-gated surface.

**Dual registration — the two daemons register it differently:**
- **macOS Swift daemon** (the macOS Dashboard) registers WiFi panels via `client_register {clientType:"eink-device", devices:[…]}` → the **E-ink rail** (`handleClientRegister` → `cachedEinkDevices` → `einkSection`). The fork already sends this, labelled "XTeink X3/X4".
- **Node daemon** (TUI / Android) registers WiFi boards via `device_info {board}` → the `esp32-wifi` bucket (`registerWifiEsp32`). The fork now emits this too (`sendDeviceInfo()` alongside `sendClientRegister()`), so it becomes a first-class ESP32 device there as well.

With the fork firmware SD-flashed, X3/X4 operate normally and register on both dashboards (verified live against the daemon on 2026-07-19). They flash via SD `update.bin` only (pogo USB-data dead) → `otaSupported:false`, and have no `esp32/` pio env, so they are **not WiFi-OTA targets** (no `ESP32_OTA_BOARDS` entry). Registration is board-agnostic and needs no such entry.

The contract the fork ports from is [esp32-client-contract.md](esp32-client-contract.md); the port-sync discipline that keeps it from drifting is in [esp32.md § Downstream client port sync](esp32.md#downstream-client-port-sync). Spec/experimental-status detail: the X3/X4 rows and operational exceptions in [hardware-compatibility.md](hardware-compatibility.md).

**Dashboard layout parity:** X3/X4 use the same mirrored `eink_dashboard_layout.h` geometry as InkDeck while retaining CrossPoint's GfxRenderer, CJK font loader, button hints, and detail/decision interaction. Column count follows orientation, not the model: `columns = portrait ? 1 : (width ≥ 1180 || (width ≥ 720 && sessions ≥ 5) ? 3 : 2)`. Both readers are portrait by default — X3 at 528×792 and X4 at 480×800 (the X4 datasheet quotes 800×480 long-axis-first, but the firmware declares 480×800 and CrossPoint boots `PORTRAIT`) — so both render a one-column paged card stack, and rotating a reader is what selects two columns. InkDeck's fixed 800×480 landscape surface always takes two, or three when five or more sessions need to fit. Density is separate and keys off the short edge, so X4 and InkDeck are both `Compact` while X3 is `Regular`. Attention sessions stay first and use a solid state chip; selection uses a double outline + rail, avoiding gray dither on partial refreshes.

## Broadcast Architecture

```
Adapter (ClaudeCode / OpenClaw)
  │
  ▼
StateMachine → BridgeEvent
  │
  ▼
WsServer.broadcast(event)  ──→  WebSocket clients (Plugin, Android, Apple)
  │
  ├── onBroadcast hooks:
  │   ├── broadcastESP32()  ──→  USB Serial JSON lines
  │   └── broadcastPixoo()  ──→  HTTP REST push
  │
  ├── frame pollers:
  │   └── Timebox sync_ble.py  ──→  BLE GATT frames (micro layout)
  │
  └── explicit calls:
      └── broadcastSse()    ──→  SSE event stream
```

All devices receive the same `BridgeEvent` JSON — only the transport differs.
ESP32 and Pixoo filter via `FORWARDED_EVENTS` sets (defined in `shared/src/protocol.ts`).

## Event Forwarding

Shared constants in `shared/src/protocol.ts`:

| Constant | Events | Used by |
|----------|--------|---------|
| `DISPLAY_FORWARDED_EVENTS` | `state_update`, `usage_update`, `sessions_list`, `connection` | Pixoo64 |
| `SERIAL_FORWARDED_EVENTS` | Above + `timeline_event`, `timeline_history` | ESP32 |

WebSocket and SSE forward all 13 `BridgeEvent` types without filtering.

## Device Details

### Stream Deck+ (Plugin)

- **Transport**: WebSocket to daemon
- **Discovery**: `daemon.json` port → mDNS fallback
- **Auth**: `~/.agentdeck/auth-token` (32-char hex), local connections bypass
- **Protocol**: Full `BridgeEvent` / `PluginCommand` bidirectional
- **Capability gating**: Actions check `AgentCapabilities` for feature availability
- **When daemon unavailable**: Plugin remains disconnected and retries the daemon; OpenClaw traffic is always proxied through the daemon

### Android (Tablet / E-ink)

- **Transport**: OkHttp WebSocket + HTTP endpoints (to daemon)
- **Discovery**: NSD mDNS (`_agentdeck._tcp`, daemon only advertises) → ADB reverse tunnel → QR pairing
- **Auth**: Token from mDNS TXT record or QR code
- **Special endpoints** (on daemon):
  - `POST /voice/transcribe` — WAV upload → on-device transcription (bundled helper, Apple Speech)
  - `GET /health` — Daemon health check (includes `mode: 'daemon'`)
  - `GET /usage` — Usage data relay
- **ADB reverse**: Daemon polls USB devices every 30s, auto-sets `adb reverse tcp:{daemonPort}`
- **Reconnect**: localhost 5 failures → clear URL → fall back to mDNS discovery

### Apple (iPhone / iPad / macOS)

- **Transport**: URLSessionWebSocketTask + HTTP endpoints
- **Discovery**: NWBrowser (Network.framework) mDNS (`_agentdeck._tcp`, daemon only advertises) → QR pairing (VisionKit)
- **Auth**: Token from mDNS TXT record or QR code
- **Special endpoints**:
  - `POST /voice/transcribe` — WAV upload → on-device transcription (AVAudioEngine 16kHz mono)
- **Platform**: SwiftUI Multiplatform — single Xcode project, iOS + macOS native targets (no Mac Catalyst)
- **Deployment target**: iOS 17.0 / iPadOS 17.0 / macOS 26.0 (macOS app now targets Apple Intelligence / Foundation Models availability; iOS remains a read-only companion)
- **State**: `@Observable` (Observation framework) — equivalent to Android's MutableStateFlow
- **Terrarium**: Canvas + TimelineView(.animation) 60fps, Metal backend automatic
- **Layout**:
  - iPhone (compact): Vertical stack HUD, pull-up Engine sheet
  - iPad (regular): Same as Android tablet — terrarium background + 4-corner HUD overlay
  - macOS: Separate WindowGroup, external monitor fullscreen, LSUIElement menu bar mode
- **Distribution**: [Mac App Store](https://apps.apple.com/app/id6784822497) (`bound.serendipity.agent.deck`, macOS 1.0.2 live); iPhone/iPad companion on TestFlight, not yet released on the App Store
- **Source**: `apple/` (pnpm workspace 외부, `android/`와 동일 레벨)
- **Status**: macOS production release; iPhone/iPad companion 1.0.2 rejected 2026-08-04 (Guideline 2.1(a)), fix built and awaiting resubmission

### ESP32 Touch Display

- **Transport**: USB Serial (CH340/CP210x/Native CDC), 115200 baud, newline-delimited JSON; WiFi WebSocket to daemon after provisioning
- **Discovery**: Port scan every 10s (`/dev/cu.usbserial-*` macOS, `/dev/ttyUSB*` Linux) plus mDNS daemon discovery from firmware
- **Heartbeat**: Full state re-push every 5s via `setESP32StateProvider()`
- **Events**: 6 types (`SERIAL_FORWARDED_EVENTS`)
- **Direction**: Dashboard state push plus OTA control/ack messages on OTA-capable WiFi boards
- **Boards**: IPS 3.5" (480×320), 86 Box 4" (480×480), Round AMOLED (360×360), TTGO T-Display, Ulanzi TC001, IPS 10.1", InkDeck

### ESP32 WiFi OTA

- **Scope**: Only directly flashed AgentDeck ESP32 firmware targets with WiFi connectivity and a dual-OTA partition table. Non-AgentDeck firmware and devices we do not flash directly are excluded.
- **Targets**: `inkdeck`, `ulanzi_tc001`/`led8x32`, `ttgo`, `ips35`, `round_amoled`/`amoled`, `86box`/`box_86`, `ips10`/`ips_10`. Any board on a single-app (non-dual-OTA) partition layout is out of scope and rejected before upload.
- **Control path**: CLI `agentdeck esp32-ota <target> [--build|--firmware <path>]` → daemon `POST /esp32/ota` → board WiFi WebSocket.
- **Protocol**: daemon sends `esp32_ota_begin/chunk/end/abort`; firmware returns `esp32_ota_ack/error`. Firmware reports capability in `device_info` so the daemon can reject unsupported boards before upload.
- **Migration**: `86box` and `ips10` became OTA-capable after 2026-07-05 16MB dual-OTA partition changes. Existing devices on older NO_OTA/factory layouts need one USB full flash first; future updates can use WiFi OTA.
- **Verified lab devices**: On 2026-07-05, `86box` was USB-migrated and detected as `OTA 7.8MB`; `ips_10` was USB-migrated and detected as `OTA 6.0MB`. Both are now eligible for `agentdeck esp32-ota <target>` once connected over WiFi.

### Pixoo64 LED Matrix

- **Transport**: HTTP REST to Divoom device LAN IP (port 80)
- **Discovery**: local `/24` probe first; Divoom Cloud API fallback in the Node daemon; manual IP in `~/.agentdeck/pixoo.json`
- **Events**: 4 types (`DISPLAY_FORWARDED_EVENTS`)
- **Rendering**: state → native 64×64 RGB scene with official agent masks and matched Claude/Codex provider rows; 9×7 official-mask creature silhouettes identify the rows, which show primary/5h and secondary/7d percentage fills with reset countdowns → Divoom HTTP API
- **Adaptive push**: active states advance through moving single frames every 2.5s, idle refreshes every 10s, and user-visible state changes use a 1s load floor. Multi-frame GIF upload is deliberately disabled: on the tested Pixoo64 firmware it caused REST timeout and 60–87.5% ping loss. Failed attempts are rate-limited and a fresh one-shot probe immediately replaces a wedged long-lived URLSession.
- **Why HTTP**: Pixoo64's supported control surface is Divoom's LAN REST API; no supported raw-frame BLE path is published. The safe practical improvement is a faster bounded single-frame cadence, not an undocumented BLE transport or a GIF request that destabilizes the device.
- **Config**: `~/.agentdeck/pixoo.json` — `{ devices: [{ ip, name? }] }`
- **Source**: `bridge/src/pixoo/` (6 files: client, bridge, renderer, sprites, font, settings)

### iDotMatrix 32×32

- **Transport**: BLE GATT transparent-UART. The App Store daemon uses native CoreBluetooth; the CLI daemon uses `bridge/src/idotmatrix/sync.py`.
- **Discovery**: brand-independent. A peripheral counts as a panel when it advertises service `000000fa-…`, or when its advertised name matches a known family (`IDM-` iDotMatrix, `iPixel-`). The same 32×32 hardware ships under several brand names, so a vendor prefix alone is not the filter. Both scanners — Swift CoreBluetooth and `scan.py` (bleak) — apply the identical predicate from `shared/src/idotmatrix-identity.ts` via generated mirrors (`pnpm generate-idotmatrix-identity`). For a panel that neither advertises the service nor uses a known name, add `idotmatrixNamePrefixes: ["myprefix-"]` to `settings.json`; adding the BLE address to `idotmatrixDevices` by hand still bypasses discovery entirely.
- **CLI runtime**: `@agentdeck/bridge` ships the Python clients. The first explicit BLE command prepares `bleak`, Pillow, and `idotmatrix` in `~/.agentdeck/python-ble`; use `agentdeck ble status` or `agentdeck ble setup` to inspect or prepare it directly. npm installation itself does not contact PyPI.
- **Rendering**: Node and Swift compose the same native 32×32 identity stage. Up to three generated official marks are placed directly at 18/13/10 physical pixels on a blue-black field using a high-saturation device palette. Four one-pixel rails reserve fixed positions for Claude 5h/7d and Codex primary/secondary limits. It does not shrink the finished Pixoo64 scene, so hollow centers, eyes, and negative space survive the diffuser.
- **Output tuning**: conservative 1.22 brightness / 1.08 contrast compensation in both native and CLI paths; the former 1.6 / 1.2 boost washed out defining holes.
- **Constraint**: one BLE connection per daemon; brightness command range 5–100%.

### Divoom Timebox Mini

The Timebox Mini drives an 11×11 LED screen over **BLE**. A `timeboxDevices` entry carries the BLE `address`; `agentdeck timebox scan` discovers `TimeBox-mini-light` peripherals and `add <address>` registers one.

- **BLE** — BLE GATT over the ISSC transparent-UART service `49535343-fe7d-…` (write char `49535343-8841-…`, write-without-response, 20-byte chunks). Advertises as `TimeBox-mini-light` (sharing its BD_ADDR with the Classic audio endpoint `TimeBox-mini-audio`). Driven by `sync_ble.py` (bleak) on the CLI daemon **and natively by the App Store Swift daemon over CoreBluetooth** (no subprocess). (The legacy Bluetooth Classic SPP variant was removed — poor macOS compatibility, no App Store path.)

- **Rendering — Agent Beacon**: the panel is intentionally not a miniature aquarium. A generated 9×9 official agent mark occupies the stable center with four deliberate 4-bit-safe shading levels, while a continuous dim perimeter frame carries brighter status motion: cyan chase for processing, alternating amber corners for awaiting, red dashed pulse for error, and calm green corners for idle. Identity geometry never animates or deforms. The 9×9 masks come directly from `design/brand/*.svg` through `pnpm generate-micro-glyphs`; `bridge/src/pixoo/micro-glyphs.ts` and `apple/.../Modules/MicroGlyphs.swift` own only device-specific color, shading, and motion. Usage rails are intentionally omitted because they would consume the identity pixels. The 11×11 RGB → Divoom static-image packet uses 4-bit nibbles, `0x44`, and escaped `0x01…0x02` framing; `TimeboxDivoomPacket` is byte-verified against `sync_ble.py`.
- **Heartbeat**: polls the frame endpoint (~1.5s) and sends only changed frames.
- **Config**: `~/.agentdeck/settings.json` — `{ timeboxDevices: [{ address, name?, brightness? }] }`
- **Source**: `bridge/src/timebox/` (settings, daemon sync manager, `sync_ble.py`/`scan_ble.py`); App Store: `apple/AgentDeck/Daemon/Modules/Timebox{BLE,Module,DivoomPacket}.swift`
- **Tier**: both CLI daemon and App Store Swift daemon (BLE).

### SSE (Server-Sent Events)

- **Transport**: HTTP SSE at `GET /sse` on daemon port
- **Auth**: Token query parameter (local bypass)
- **Format**: `event: {type}\ndata: {json}\n\n`
- **Caching**: Bridge caches last `state_update` and `usage_update` for late-connecting clients
- **Events**: All 13 types (no filtering)
- **Use case**: Browser dashboards, monitoring scripts, external integrations

### OpenClaw Gateway (Adapter)

- **Transport**: WebSocket with custom framing `{ type: "req"/"res"/"event", ... }`
- **Port**: 18789 (default)
- **Auth**: Ed25519 device key handshake (`~/.openclaw/identity/`)
- **Protocol**: `chat.send`, `chat.abort`, `exec.approval.resolve`, `sessions.list`
- **Events**: `chat`, `exec.approval.*`, `presence`, `tick`, `shutdown`
- **Note**: Not a dashboard device — it's an upstream agent adapter. Both bridge (`OpenClawAdapter`) and plugin (`GatewayClient`) implement the protocol independently (plugin needs standalone operation).

## Heartbeat Mechanisms

| Device | Method | Interval |
|--------|--------|----------|
| WebSocket | `ws.ping()` | 15s |
| ESP32 | Full state JSON re-push | 5s |
| Pixoo64 | Adaptive HTTP frame refresh | 2.5s active, 10s idle, 1s state floor |
| Timebox Mini (BLE) | Current frame poll + changed-frame push | 1.5s |
| ADB tunnel | `adb devices` poll + re-setup | 30s |
| SSE | No heartbeat (HTTP keep-alive) | — |

## Adding a New Device

1. Create `bridge/src/{device}.ts` with start/stop/broadcast functions
2. Filter events using `DISPLAY_FORWARDED_EVENTS` or `SERIAL_FORWARDED_EVENTS` from `shared/src/protocol.ts` (or define a new set if needed)
3. Register broadcast hook: `wsServer.onBroadcast(broadcastNewDevice)` in `bridge/src/index.ts`
4. Add discovery/polling if needed
5. Update this document
