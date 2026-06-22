# AgentDeck Dashboard Devices

대시보드 디바이스 + 프로토콜 종합 레퍼런스 (전송/디스커버리/이벤트 중심). 하드웨어/OS 사양 전체 인벤토리는 [hardware-compatibility.md](hardware-compatibility.md) 가 SSOT.

## Device Matrix

| Device | Transport | Port | Auth | Discovery | Direction | Events |
|--------|-----------|------|------|-----------|-----------|--------|
| **Stream Deck+** | WebSocket JSON | Daemon (9120) | Token (local bypass) | `daemon.json` / mDNS | Bidirectional | All 13 |
| **Android** | WebSocket + HTTP | Daemon (9120) | Token (local bypass) | mDNS / ADB / QR | Bidirectional | All 13 |
| **Apple** | WebSocket + HTTP | Daemon (9120) | Token | mDNS / QR | Bidirectional | All 13 |
| **ESP32** | USB Serial JSON | CDC/UART 115200 | None | Port scan 10s | Push only | 6 |
| **Pixoo64** | HTTP REST (Divoom) | LAN:80 | None | Cloud API / manual | Push only | 4 |
| **Timebox Mini** | BLE GATT (ISSC transparent-UART) | `49535343-…` | Bluetooth pairing | `TimeBox-mini-light` BLE scan | Push only | 4 |
| **TRMNL e-ink (BYOS)** | HTTP BYOS (device pulls) | Daemon (9120) | MAC (soft) | Manual server URL | **Pull** (panel polls) | status+usage frame |
| **SSE** | HTTP SSE | Daemon (9120) | Token | Manual URL | Push only | All 13 |
| **Gateway** | WebSocket Custom | 18789 | Ed25519 | Hardcoded | Bidirectional | N/A (adapter) |

> **Daemon hub**: All dashboard clients connect exclusively to the daemon. Session bridges handle PTY + hooks only and do not serve external devices. Daemon port defaults to 9120; if occupied by non-daemon process, daemon falls back to next available port and records actual port in `~/.agentdeck/daemon.json`. Local clients read `daemon.json`; remote clients discover via mDNS (daemon only advertises `_agentdeck._tcp`).

## TRMNL e-ink (BYOS)

TRMNL is **pull-only**: the panel stores one fixed server URL and polls `/api/setup` + `/api/display` on its own schedule, then downloads a server-rendered **1-bit PNG**. AgentDeck implements the BYOS contract twice — Node (`bridge/src/trmnl/`) and the App Store Swift daemon (`apple/.../Daemon/Modules/Trmnl*.swift`, CoreGraphics render, no subprocess).

**Setup — run exactly one hub, point the panel at it.** Print the stable URL with:

```bash
agentdeck trmnl     # prints http://<LAN-IP>:9120 + enrolled panels + health
```

Set that one URL as the panel's custom/BYOS server. It auto-enrolls on first poll (no MAC entry). **Critical:** run a single daemon as the hub on a stable `LAN-IP:9120`. The **Node daemon is the usage-capable hub** (it reads Claude OAuth quota); the **macOS app should run as a client** (`isUsingExternalDaemon`). Two hubs racing for port 9120 — or a panel pinned to a fallback port that comes and goes — is what makes the firmware flip between the dashboard and its **"WiFi connected / TRMNL not responding"** error screen.

**Behavior** (aligned to the `usetrmnl/firmware` BYOS contract):
- **Response shape** — `/api/display` returns `status:0, image_url, filename, refresh_rate (number), image_url_timeout, special_function:"sleep", reset_firmware:false, update_firmware:false, firmware_url:null`. `refresh_rate` is a **number** (the firmware parses it as a uint; a string can read as 0). `image_url` is 1-bit **PNG** (firmware sniffs `BM` → BMP, else PNG/JPEG — PNG is supported).
- **Stable `filename`** — the firmware caches the image by `filename` and **skips the re-download when it's unchanged**. So the frame hash changes ONLY on real visual change — never for a ticking clock. This is what keeps a battery panel on a flaky link from re-downloading (and full-flashing the e-ink) every poll.
- **Gentle adaptive cadence** — `refresh_rate` is `trmnl.refreshActive` (default **60s**) only while a session is **AWAITING** the user; otherwise `trmnl.refreshRate` (default 180s). "Working" does NOT speed it up — a deep-sleep panel can't be pushed and each wake flashes the screen + costs battery. Floor 30s.
- **`image_url_timeout`** (`trmnl.imageUrlTimeout`, default 30s, firmware caps ~65s) — the download window the firmware honors, so a slow/flaky WiFi link doesn't trip the device's **"WiFi connected / not responding"** (`WIFI_FAILED`) screen. That screen is a *device-side request failure* (network/timeout), not a server error — verify LAN packet loss to the panel if it persists.
- **Usage** — the gauges come from `usage_update` (not `state_update`); the module merges both. No quota → hatched "—", never a misleading `0%`. Footer shows 5H/7D gauge + % + **time-until-reset**; no token tally or wall clock.
- **AWAITING banner** — any awaiting agent gets a full-width inverted banner above the rows.
- **Health** — `agentdeck trmnl` and `/status` `modules.trmnl` expose per-panel lastSeen/battery/RSSI + a `stale` flag.

Settings (`~/.agentdeck/settings.json` `trmnl` block): `enabled`, `refreshRate`, `refreshActive`, `imageUrlTimeout`, `autoRegister`, `devices[]`.

Reference: [BYOS docs](https://docs.trmnl.com/go/diy/byos) · [byos_sinatra](https://github.com/usetrmnl/byos_sinatra) (canonical response shape) · [firmware](https://github.com/usetrmnl/firmware) (`src/bl.cpp` — image sniff, `image_url_timeout`, `WIFI_FAILED`).

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
- **When daemon unavailable**: Plugin connects directly to OpenClaw Gateway via `GatewayClient`

### Android (Tablet / E-ink)

- **Transport**: OkHttp WebSocket + HTTP endpoints (to daemon)
- **Discovery**: NSD mDNS (`_agentdeck._tcp`, daemon only advertises) → ADB reverse tunnel → QR pairing
- **Auth**: Token from mDNS TXT record or QR code
- **Special endpoints** (on daemon):
  - `POST /voice/transcribe` — WAV upload → whisper transcription
  - `GET /health` — Daemon health check (includes `mode: 'daemon'`)
  - `GET /usage` — Usage data relay
- **ADB reverse**: Daemon polls USB devices every 30s, auto-sets `adb reverse tcp:{daemonPort}`
- **Reconnect**: localhost 5 failures → clear URL → fall back to mDNS discovery

### Apple (iPhone / iPad / macOS)

- **Transport**: URLSessionWebSocketTask + HTTP endpoints
- **Discovery**: NWBrowser (Network.framework) mDNS (`_agentdeck._tcp`, daemon only advertises) → QR pairing (VisionKit)
- **Auth**: Token from mDNS TXT record or QR code
- **Special endpoints**:
  - `POST /voice/transcribe` — WAV upload → whisper transcription (AVAudioEngine 16kHz mono)
- **Platform**: SwiftUI Multiplatform — single Xcode project, iOS + macOS native targets (no Mac Catalyst)
- **Deployment target**: iOS 17.0 / iPadOS 17.0 / macOS 15.0 (macOS 15 raised on 2026-05-10 to use `Scene.defaultLaunchBehavior(.suppressed)` for Evaluation/Settings restoration suppression)
- **State**: `@Observable` (Observation framework) — equivalent to Android's MutableStateFlow
- **Terrarium**: Canvas + TimelineView(.animation) 60fps, Metal backend automatic
- **Layout**:
  - iPhone (compact): Vertical stack HUD, pull-up Engine sheet
  - iPad (regular): Same as Android tablet — terrarium background + 4-corner HUD overlay
  - macOS: Separate WindowGroup, external monitor fullscreen, LSUIElement menu bar mode
- **Distribution**: App Store (`dev.agentdeck.dashboard`), TestFlight beta
- **Source**: `apple/` (pnpm workspace 외부, `android/`와 동일 레벨)
- **Status**: In progress (Phase 1–6 구현 중)

### ESP32 Touch Display

- **Transport**: USB Serial (CH340/CP210x), 115200 baud, newline-delimited JSON
- **Discovery**: Port scan every 10s (`/dev/cu.usbserial-*` macOS, `/dev/ttyUSB*` Linux)
- **Heartbeat**: Full state re-push every 5s via `setESP32StateProvider()`
- **Events**: 6 types (`SERIAL_FORWARDED_EVENTS`)
- **Direction**: Push only — no commands from ESP32
- **Boards**: IPS 3.5" (480×320), 86 Box 4" (480×480), Round AMOLED (240×240)

### Pixoo64 LED Matrix

- **Transport**: HTTP REST to Divoom device LAN IP (port 80)
- **Discovery**: Divoom Cloud API (`app.divoom-gz.com`) or manual IP in `~/.agentdeck/pixoo.json`
- **Events**: 4 types (`DISPLAY_FORWARDED_EVENTS`)
- **Rendering**: State → 64×64 RGB pixel buffer → Divoom HTTP API
- **Heartbeat**: Current frame re-push every 10s
- **Animation**: Idle animation at 600ms/frame (4 frames), PROCESSING state animation
- **Config**: `~/.agentdeck/pixoo.json` — `{ devices: [{ ip, name? }] }`
- **Source**: `bridge/src/pixoo/` (6 files: client, bridge, renderer, sprites, font, settings)

### Divoom Timebox Mini

The Timebox Mini drives an 11×11 LED screen over **BLE**. A `timeboxDevices` entry carries the BLE `address`; `agentdeck timebox scan` discovers `TimeBox-mini-light` peripherals and `add <address>` registers one.

- **BLE** — BLE GATT over the ISSC transparent-UART service `49535343-fe7d-…` (write char `49535343-8841-…`, write-without-response, 20-byte chunks). Advertises as `TimeBox-mini-light` (sharing its BD_ADDR with the Classic audio endpoint `TimeBox-mini-audio`). Driven by `sync_ble.py` (bleak) on the CLI daemon **and natively by the App Store Swift daemon over CoreBluetooth** (no subprocess). (The legacy Bluetooth Classic SPP variant was removed — poor macOS compatibility, no App Store path.)

- **Rendering**: dedicated **micro** layout (`/pixoo/frame?size=11&layout=micro`) — a bold, hand-authored **native 11×11 creature glyph** (octopus/codex/opencode/crayfish, with the brand identity marks) on a semantic status field, drawn pixel-for-pixel at the device resolution (no downscale — that bottoms out at a fuzzy silhouette at 121 LEDs). Glyph tables are the SSOT in `bridge/src/pixoo/micro-glyphs.ts`, mirrored byte-for-byte in `apple/.../Modules/MicroGlyphs.swift`. The 11×11 RGB → Divoom static-image packet (4-bit nibbles, `0x44` command, escaped `0x01…0x02` frame); the Swift packet encoder is `TimeboxDivoomPacket` (byte-verified against `sync_ble.py` by `TimeboxProtocolTests`).
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
| Pixoo64 | Current frame re-render | 10s |
| Timebox Mini (BLE) | Current frame poll + changed-frame push | 1.5s |
| ADB tunnel | `adb devices` poll + re-setup | 30s |
| SSE | No heartbeat (HTTP keep-alive) | — |

## Adding a New Device

1. Create `bridge/src/{device}.ts` with start/stop/broadcast functions
2. Filter events using `DISPLAY_FORWARDED_EVENTS` or `SERIAL_FORWARDED_EVENTS` from `shared/src/protocol.ts` (or define a new set if needed)
3. Register broadcast hook: `wsServer.onBroadcast(broadcastNewDevice)` in `bridge/src/index.ts`
4. Add discovery/polling if needed
5. Update this document
