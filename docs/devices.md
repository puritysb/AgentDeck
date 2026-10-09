---
id: spec.devices
title: Device Catalog
description: Per-device behaviour for every supported dashboard surface — panels, transports, and rendering specifics.
category: Specs
locale: en
canonical: true
status: stable
owner: Device maintainers
reviewed: 2026-08-09
revision: 2026-08-09
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
| **ESP32** | USB Serial JSON + WiFi WebSocket | CDC/UART 115200 / Daemon (9120) | Token (serial-provisioned for WiFi) | Port scan 10s / mDNS | Push + OTA control | 6 + OTA ack/error |
| **T-Embed Companion Knob** | USB Serial JSON + WiFi WebSocket | CDC 115200 / Daemon (9120) | Token (serial-provisioned for WiFi) | Port scan 10s / mDNS | Bidirectional (encoder steering + voice) | 6 + OTA ack/error + steering/voice uplink |
| **T-Display-S3-Pro Focus Strip** | USB Serial JSON + WiFi WebSocket | CDC 230400 / Daemon (9120) | Token (serial-provisioned for WiFi) | Port scan 10s / mDNS | Bidirectional (touch steering) | 6 + OTA ack/error + steering uplink |
| **Pixoo64** | HTTP REST (Divoom) | LAN:80 | None | Cloud API / manual | Push only | 4 |
| **Timebox Mini** | BLE GATT (ISSC transparent-UART) | `49535343-…` | Bluetooth pairing | `TimeBox-mini-light` BLE scan | Push only | 4 |
| **TRMNL 7.5" e-ink** | WebSocket JSON (WiFi) | Daemon (9120) | Token (serial-provisioned) | mDNS / port scan | Push + OTA control | dashboard frame + OTA ack/error |
| **XTeink X3 / X4** (community fork) | WiFi WebSocket (+ UDP 9121 fallback) | Daemon (9120) | Token (explicitly provisioned) | mDNS / UDP broadcast | Push + steering (M2) | state/sessions/usage subset; registers via `client_register`(eink-device, macOS) + `device_info`(esp32-wifi, Node) |
| **SSE** | HTTP SSE | Daemon (9120) | Token | Manual URL | Push only | All 13 |
| **Gateway** | WebSocket Custom | 18789 | Ed25519 | Hardcoded | Bidirectional | N/A (adapter) |

> **Daemon hub**: All dashboard clients connect exclusively to the daemon. Session bridges handle PTY + hooks only and do not serve external devices. Daemon port defaults to 9120; if occupied by non-daemon process, daemon falls back to next available port and records actual port in `~/.agentdeck/daemon.json`. Local clients read `daemon.json`; remote clients discover via mDNS (daemon only advertises `_agentdeck._tcp`).

## TTGO T-Display (Usage Meter)

The 135×240 panel boots into **usage-only** mode. The previously unused
**GPIO0 / BTN2** button toggles Usage ↔ Terrarium; **GPIO35 / BTN1** keeps its
90° rotation behavior. Mode survives a rotation but resets to Usage on reboot.
Available Claude and Codex quota windows stay visible together, with used
percentages and reset countdowns. Missing windows are omitted (real 0% remains
visible); stale Claude usage never masks valid Codex data. One or two windows
get larger figures, while denser layouts fit all four windows in either axis.
Activity never temporarily replaces the usage screen. Terrarium animation is
paused while Usage is selected. The host display-sleep policy still applies.

## T-Embed CC1101 (Companion Knob)

**Shipping since 2026-07-25.** The LilyGO T-Embed CC1101 is the fleet's only board with a **rotary encoder**, and the only one you steer with rather than only read from — every other Shipping board is output-only apart from touch. Its UI (`esp32/src/ui/knob/`) starts with the full session roster showing the project and activity or question. Rotate to inspect another session, then press to enter local detail. A waiting-only queue remains available. Opening detail keeps selection local and does not change desktop focus. Detail requires a deliberate turn to select before pressing; changed questions or choices clear the selection. A pending reply stays unconfirmed until a state update is observed; disconnected or stale requests cannot be sent. Holding the encoder is push-to-talk — the board captures voice, the host transcribes, and the reply is spoken back through the board speaker.

It is a **dual-mode companion**: USB-powered on the desk it is a steering knob; on its 1300 mAh cell it becomes a carry-around pager that chimes when a session starts waiting. The 8× WS2812 ring is a session-status ring (one LED per session, up to eight). The BQ27220 fuel gauge gives it a real state-of-charge readout rather than an inferred one.

Peripheral breadth is the widest in the fleet — CC1101 sub-GHz, PN532 NFC, IR TX/RX, mic + speaker, microSD. NFC and IR receive are implemented; **BLE phone relay and CC1101 sub-GHz capture remain future work**. Design record and interaction grammar: [esp32-companion-concepts.md](esp32-companion-concepts.md).

## T-Display-S3-Pro (Focus Strip / Pocket)

**Shipping since 2026-07-26; switchable layout since 2026-10-07.** The
LilyGO T-Display-S3-Pro V1.1 is a 2.33″ 480×222 touch strip. Its layout is a
persisted setting (`auto` | `portrait` | `landscape`, NVS) chosen before the
display starts. `auto` (the default) boots a camera-equipped unit into the
portrait Pocket UI and a camera-less unit into the landscape Focus Strip; in
landscape a present camera adds the explicit CAM page. Three ways switch it,
each saving the setting and restarting the board:

- hold either rocker button while the board powers on or resets (toggles to
  the other layout);
- on screen: the **LANDSCAPE** button at the bottom of Pocket's USAGE tab, or a
  hold on the strip's Usage page (`HOLD = PORTRAIT`);
- from the host: `agentdeck esp32 orientation t_display_pro <auto|portrait|landscape>`
  (Node daemon `POST /esp32/orientation`; USB serial first, WiFi fallback).

`device_info` reports `layout` (running) and `layoutSetting` (persisted). The
Swift in-process daemon does not send the command yet; the two on-device paths
work under either daemon.

Focus pins the initial task and retains it when the session ends. It shows the
latest observed activity with a local observation age (not proof of a stalled
agent), and keeps actual response events separately from asks and tool activity.
The first response appears automatically; later replacements are offered with
NEW RESULT. Waiting updates the rail without stealing the page. Usage and
Sessions remain available through the rocker/tabs; explicit actions keep their
request guards. BOOT returns to Focus or toggles the local pin.

The **LTR-553 ambient light sensor** makes this the first board where the display-sleep contract takes a sensor input: brightness follows room light and the strip dims itself at night, decided locally. The SY6970 charger has no coulomb-counting register, so the header reports sampled **cell voltage** and charge state rather than an invented percentage.

Two operational constraints are load-bearing and documented in [hardware-compatibility.md](hardware-compatibility.md#esp32-board-specification-sheet): its USB CDC corrupts esptool streams above 230400 baud, and a WiFi join concurrent with display bring-up browns out the camera unit's 3.3 V rail — so the firmware never joins at boot and defers the join by ~25 s.

## TRMNL 7.5" e-ink (custom firmware)

AgentDeck's wired e-ink status panel. The hardware is a **Seeed TRMNL 7.5" OG DIY Kit** — a **XIAO ESP32-S3 Plus** wired to an 800×480 monochrome ePaper panel (GDEY075T7 / UC8179 controller), always **USB-powered** (no battery / deep-sleep). The board id is `trmnl_75`; it shipped as **InkDeck** through 1.2.1, an invented name that told nobody which kit to buy, and `inkdeck` stays an accepted alias because a board flashed before the rename still reports itself that way until it takes an OTA.

**Status: hardware-verified, shipping via WiFi OTA.** TRMNL 7.5" is driven by custom AgentDeck ESP32 firmware under `esp32/` (PlatformIO env `trmnl_75`). Both transports are implemented and verified on hardware: **USB serial** (TinyUSB CDC) and **WiFi WebSocket** (`device_info` on connect, daemon state push, OTA capability like the other directly flashed boards). Node and Swift daemons both register it, and routine updates deploy over WiFi OTA (`agentdeck esp32-ota trmnl_75`). The dashboard UI — session cards, usage footer, timeline strip, partial/full refresh policy — has been through repeated on-device validation rounds. Residual operational caveats: serial reflashing must use the download-mode port with `boot_app0.bin` included (native-CDC re-enumeration breaks plain `pio -t upload`), and a crash in the prebuilt Espressif mDNS component is under observation (does not affect rendering or OTA).

**Display-sleep policy:** TRMNL 7.5" keeps its dashboard visible when the host Mac's displays sleep or are turned off with a keyboard shortcut. Unlike LCD/OLED/LED devices, its e-ink image needs no panel refresh power to remain visible, and the panel is already continuously USB-powered. The firmware therefore ignores `display_state.displayOn` for rendering while continuing to receive and draw meaningful dashboard changes whenever the Mac itself remains awake.

**Voice-capable-panel research:** the face set this panel renders is specified in [E-ink Surface Contract](eink-surface-contract.md); [E-ink Face Research](eink-face-research.md) is issue [#272](https://github.com/puritysb/AgentDeck/issues/272)'s live-measurement + vendor hardware-table snapshot (repaint-rate counters, mic/speaker/deep-sleep-wake facts) toward the still-open voice interface.

**Connection surface:** a missing daemon link is a retained `OFFLINE` sheet with a quiet search/transport hint. `no active sessions` is reserved for the distinct case where the daemon link is live and its roster is empty; a later timed repaint must not collapse those states.

**Responsive dashboard:** the direct GxEPD2 renderer consumes the allocation-free layout model in `esp32/src/ui/eink/eink_dashboard_layout.h`. It derives header, card grid, usage, recent-activity, and control bands from the panel dimensions instead of 800×480 constants; the hardware-specific font/glyph/panel refresh code stays in `eink_display.cpp`.

**The commercial BYOS pull integration — removed.** AgentDeck previously drove this same physical panel through TRMNL's own **BYOS** (Bring Your Own Server) pull contract, where the panel polled `/api/setup` + `/api/display` and downloaded a server-rendered PNG. That integration was **removed** (Node commit `c71044bd`; the App Store Swift `Trmnl*` modules removed alongside). Stock / commercial TRMNL panels running the upstream `usetrmnl/firmware` are **no longer supported**: AgentDeck reflashes the same hardware with its own firmware and treats it as a first-class ESP32 board. The name is shared with the kit, the protocol is not.

## XTeink X3 / X4 (external-fork client)

**XTeink X3 and X4** are ESP32-C3 e-ink readers supported by the independent [Pocket Daily Reader](https://github.com/puritysb/pocket-daily-reader), **not** by AgentDeck's own `esp32/` firmware. Its `src/agentdeck/` compatibility module is a hand-port of the bounded AgentDeck client contract and adds offline-first Feed/Glance/Outbox operation. **One firmware** auto-detects the model at runtime (`gpio.deviceIsX3()`, via an I2C IMU fingerprint) and reports `xteink_x3` or `xteink_x4`. AgentDeck treats it as a Compatible Companion Project with its own product identity and releases.

**Dual registration — the two daemons register it differently:**
- **macOS Swift daemon** (the macOS Dashboard) registers WiFi panels via `client_register {clientType:"eink-device", devices:[…]}` → the **E-ink rail** (`handleClientRegister` → `cachedEinkDevices` → `einkSection`). The fork already sends this, labelled "XTeink X3/X4".
- **Node daemon** (TUI / Android) registers WiFi boards via `device_info {board}` → the `esp32-wifi` bucket (`registerWifiEsp32`). The fork now emits this too (`sendDeviceInfo()` alongside `sendClientRegister()`), so it becomes a first-class ESP32 device there as well.

With the fork firmware SD-flashed, X3/X4 operate normally and register on both dashboards (verified live against the daemon on 2026-07-19). They flash via SD `update.bin` only (pogo USB-data dead) → `otaSupported:false`, and have no `esp32/` pio env, so they are **not WiFi-OTA targets** (no `ESP32_OTA_BOARDS` entry). Registration is board-agnostic and needs no such entry.

The contract the fork ports from is [esp32-client-contract.md](esp32-client-contract.md); the port-sync discipline that keeps it from drifting is in [esp32.md § Downstream client port sync](esp32.md#downstream-client-port-sync). Spec/experimental-status detail: the X3/X4 rows and operational exceptions in [hardware-compatibility.md](hardware-compatibility.md).

**Dashboard layout parity:** X3/X4 use the same mirrored `eink_dashboard_layout.h` geometry as TRMNL 7.5" while retaining CrossPoint's GfxRenderer, CJK font loader, button hints, and detail/decision interaction. Column count follows orientation, not the model: `columns = portrait ? 1 : (width ≥ 1180 || (width ≥ 720 && sessions ≥ 5) ? 3 : 2)`. Both readers are portrait by default — X3 at 528×792 and X4 at 480×800 (the X4 datasheet quotes 800×480 long-axis-first, but the firmware declares 480×800 and CrossPoint boots `PORTRAIT`) — so both render a one-column paged card stack, and rotating a reader is what selects two columns. the TRMNL's fixed 800×480 landscape surface always takes two, or three when five or more sessions need to fit. Density is separate and keys off the short edge, so X4 and TRMNL 7.5" are both `Compact` while X3 is `Regular`. Attention sessions stay first and use a solid state chip; selection uses a double outline + rail, avoiding gray dither on partial refreshes.

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

## Codex usage is a passive read of your own rollout files

Every device that draws a Codex gauge — the Pixoo64 provider row, the iDotMatrix
rails, the TRMNL 7.5" `CODEX` row, the TC001/knob/pocket readouts, both deck strips —
consumes the same `codexRateLimits` block, and none of them can improve on it.
Codex writes a `rate_limits` snapshot into `~/.codex/sessions/**/rollout-*.jsonl`
on every completed turn; AgentDeck reads that file. No OpenAI API is contacted.
Three independent questions decide what a device shows, and folding any two of
them together breaks a surface:

| Question | Signal | What a device does |
|---|---|---|
| Has the window ENDED? | `window.stale` (producer, from `resetsAt`) | **Hide the gauge.** Slot-based consumers drop it entirely — this is the hard signal |
| How OLD is the reading? | `capturedAt` + the consumer's own clock | Keep drawing it, dimmed, with its age (`"4d ago"`) in place of the countdown |
| Is it still THIS account's? | snapshot `plan_type` vs the live tier in `auth.json` | **Void it.** A snapshot minted under a plan the account no longer holds is not old, it is wrong |

The third question exists because the first two cannot answer it. A lapsed
ChatGPT Plus leaves a weekly window whose `resetsAt` stays up to seven days in
the future, so `stale` never fires and `capturedAt` only dims it — the retired
plan's percentage keeps rendering. Reconciliation happens once, at the producer
(`normalizeCodexRateLimits` in the Node daemon, `codexRateLimitsPayload` in the
Swift one, sharing `codexSnapshotMatchesAccountPlan`), so no device implements
it. Unknown on either side means keep: absence is no information, not a licence
to delete real data.

Two consequences for device code:

- **A voided snapshot still rides the wire**, as a windowless block carrying only
  the account tier. Clients merge usage fields retain-on-absent, so omitting the
  key would pin the retired gauge forever. Test for a **window**, never for the
  block's presence — `codexRateLimits != null` is true for an account with
  nothing to show.
- **A free tier is not automatically empty.** It reports real windows (a 30-day
  one, for instance) and those are honest data. What a free tier lacks is the
  *subscription* windows, which is why surfaces that name the plan render
  "ChatGPT Free" rather than hiding the provider outright.

Only the Node daemon can go beyond the passive read: it backs it with a
throttled `codex app-server` JSON-RPC query, and the fresher snapshot wins by
`capturedAt`. The App Store Swift daemon spawns no subprocess, so it is
passive-only — see [appstore-feature-matrix.md](appstore-feature-matrix.md).

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
- **Auth**: Token from explicit QR/manual pairing (never from discovery)
- **Special endpoints** (on daemon):
  - `POST /voice/transcribe` — WAV upload → on-device transcription (bundled helper, Apple Speech)
  - `GET /health` — Daemon health check (includes `mode: 'daemon'`)
  - `GET /usage` — Usage data relay
- **ADB reverse**: Daemon polls USB devices every 30s, auto-sets `adb reverse tcp:{daemonPort}`
- **Reconnect**: localhost 5 failures → clear URL → fall back to mDNS discovery

### Apple (iPhone / iPad / macOS)

- **Transport**: URLSessionWebSocketTask + HTTP endpoints
- **Discovery**: NWBrowser (Network.framework) mDNS (`_agentdeck._tcp`, daemon only advertises) → QR pairing (VisionKit)
- **Auth**: Token from explicit QR/manual pairing (never from discovery)
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
- **Boards**: IPS 3.5" (480×320), 86 Box 4" (480×480), Round AMOLED (360×360), TTGO T-Display, Ulanzi TC001, IPS 10.1", TRMNL 7.5"

### ESP32 WiFi OTA

- **Scope**: Only directly flashed AgentDeck ESP32 firmware targets with WiFi connectivity and a dual-OTA partition table. Non-AgentDeck firmware and devices we do not flash directly are excluded.
- **Targets**: `trmnl_75`, `ulanzi_tc001`/`led8x32`, `ttgo`, `ips35`, `round_amoled`/`amoled`, `86box`/`box_86`, `ips10`/`ips_10`. Any board on a single-app (non-dual-OTA) partition layout is out of scope and rejected before upload.
- **Control path**: CLI `agentdeck esp32-ota <target> [--build|--firmware <path>]` → daemon `POST /esp32/ota` → board WiFi WebSocket.
- **Protocol**: daemon sends `esp32_ota_begin/chunk/end/abort`; firmware returns `esp32_ota_ack/error`. Firmware reports capability in `device_info` so the daemon can reject unsupported boards before upload.
- **Migration**: `86box` and `ips10` became OTA-capable after 2026-07-05 16MB dual-OTA partition changes. Existing devices on older NO_OTA/factory layouts need one USB full flash first; future updates can use WiFi OTA.
- **Verified lab devices**: On 2026-07-05, `86box` was USB-migrated and detected as `OTA 7.8MB`; `ips_10` was USB-migrated and detected as `OTA 6.0MB`. Both are now eligible for `agentdeck esp32-ota <target>` once connected over WiFi.

### Pixoo64 LED Matrix

- **Transport**: HTTP REST to Divoom device LAN IP (port 80)
- **Discovery**: local `/24` probe first; Divoom Cloud API fallback in the Node daemon; manual IP in `~/.agentdeck/pixoo.json`
- **Events**: 4 types (`DISPLAY_FORWARDED_EVENTS`)
- **Rendering**: state → native 64×64 RGB scene with official agent masks and matched Claude/Codex provider rows; 9×7 official-mask creature silhouettes identify the rows, which show primary/5h and secondary/7d percentage fills with reset countdowns → Divoom HTTP API. Each row is a seven-pixel band and a provider with no live window claims none: two providers occupy rows 50-63, one sits on 57-63, and with neither the tank keeps the full height. (An account whose Codex snapshot was voided by a plan change loses its band — see [§ Codex usage](#codex-usage-is-a-passive-read-of-your-own-rollout-files).)
- **Offline rendering**: all pixel targets keep a static, mostly dark badge with sparse dim-cyan accents to minimize LED draw. Pixoo64/iDotMatrix use the same diagonal 3×5 `N` in `OFFLINE`; Timebox uses a sparse 11×11 no-link glyph because the word is not legible at that resolution.
- **Adaptive push**: active states advance through moving single frames every 2.5s, idle refreshes every 10s, and user-visible state changes use a 1s load floor. Failed attempts are rate-limited and a fresh one-shot probe immediately replaces a wedged long-lived URLSession. Integrated scene motion (tetra school, bubbles, data particles) follows wall time — each render replays the 100 ms ticks elapsed since the last one, capped at 30 — so one push per 2.5s no longer runs the school at 1/25 speed.
- **Device-side loop (opt-in, Node daemon only, not yet hardware-validated)**: `"animation": "loop"` on a device entry (`pixooDevices` in `~/.agentdeck/settings.json`) uploads a closed palindrome loop — 8 unique frames rendered 200 ms apart, 14 frames played at 200 ms (5 fps) — on state change (3s floor) and every 10s, and the panel animates between uploads with no HTTP traffic. Frames go up one request per frame (shared `PicID`/`PicNum`, `PicOffset` = index, one 12,288-byte frame per `PicData`, 120 ms apart), so each body is the size of a proven single-frame push. The multi-frame attempts that caused REST timeout and 60–87.5% ping loss on the tested firmware (2026-06/07) concatenated every frame into one `PicData` at offset 0, which the Divoom API does not document. A failed loop upload drops that device to single frames for 15 minutes. The Swift daemon stays single-frame.
- **Tide scene (opt-in, Node daemon only)**: `"animation": "tide"` on a device entry replaces the aquarium with a scene drawn for the 64×64 matrix (`bridge/src/pixoo/pixoo-tide.ts`): flat dithered depth bands and a travelling waterline instead of a murky gradient, the official 24×24 agent masks at native size (18 px for three sessions, 14 px for four, `+N` beyond four) instead of a ~58 px zoom, a light sweep over a working mark, the amber dotted ring on a needs-you mark, bubbles, ambient fish, kelp and sand. The usage HUD on rows 50–63 is the unchanged `drawUsageHUD`. It is one closed 6-frame loop at 500 ms (3 s); every animated value is a function of `tick / 6`, nothing uses `Math.random`, and `pixoo-tide.test.ts` fails if the last-to-first step is larger than any other. **Upload policy** (measured on the Pixoo64, 2026-10-08): an upload costs ~0.27 s per frame (6 frames ≈ 1.6 s) and the panel shows its loading hourglass for that ingest, once per content change, so uploads are justified only by what the panel would show differently. `tideSignature` splits that into the marks/states/CI cue (`scene`) and the usage strip (`hud`); a scene change re-bakes at most every 15 s, a usage-only change at most every 5 min (the reset countdown ticks every minute), and otherwise the bridge asks `Channel/GetIndex` + `Draw/GetHttpGifId` every 30 s and re-uploads only when the answer is `stale` (channel ≠ Custom, or the PicID counter fell — a reboot). The check is `>=`, not equality: the device counter does not track the uploaded ID one-for-one. `unknown` (a failed query) retains. A failed upload backs off tide uploads for 60 s and **never falls back to single frames**: a one-frame upload after a multi-frame one tangled the panel's picture and colours. The Swift daemon draws the same scene and follows the same policy (`apple/AgentDeck/Daemon/Modules/PixooTide.swift`, a hand-ported twin; `"animation": "tide"` in the app's own `settings.json`): both renderers are pinned to one table of frame digests (`pixoo-tide.test.ts` and `PixooTideTests.swift`), so a change to either fails the other until it is ported.
- **Why HTTP**: Pixoo64's supported control surface is Divoom's LAN REST API; no supported raw-frame BLE path is published. Single-frame cadence cannot go much faster safely, so smooth motion has to come from the device playing a loop, not from more requests or an undocumented BLE transport.
- **Config**: `~/.agentdeck/pixoo.json` — `{ devices: [{ ip, name? }] }`
- **Source**: `bridge/src/pixoo/` (6 files: client, bridge, renderer, sprites, font, settings)

### iDotMatrix 32×32

- **Transport**: BLE GATT transparent-UART. The App Store daemon uses native CoreBluetooth; the CLI daemon uses `bridge/src/idotmatrix/sync.py`.
- **Discovery**: brand-independent. A peripheral counts as a panel when it advertises service `000000fa-…`, or when its advertised name matches a known family (`IDM-` iDotMatrix, `iPixel-`). The same 32×32 hardware ships under several brand names, so a vendor prefix alone is not the filter. Both scanners — Swift CoreBluetooth and `scan.py` (bleak) — apply the identical predicate from `shared/src/idotmatrix-identity.ts` via generated mirrors (`pnpm generate-idotmatrix-identity`). For a panel that neither advertises the service nor uses a known name, add `idotmatrixNamePrefixes: ["myprefix-"]` to `settings.json`; adding the BLE address to `idotmatrixDevices` by hand still bypasses discovery entirely.
- **CLI runtime**: `@agentdeck/bridge` ships the Python clients. The first explicit BLE command prepares `bleak`, Pillow, and `idotmatrix` in `~/.agentdeck/python-ble`; use `agentdeck ble status` or `agentdeck ble setup` to inspect or prepare it directly. npm installation itself does not contact PyPI.
- **Rendering — agent world**: Node and native Swift share the same policy and pixel
  art. The default is a simultaneous numeric summary: `WAIT` (live awaiting
  sessions), `WORK` (live processing sessions), `RSLT` (explicit response/task-end
  events in the last 90 seconds), and `LIVE` (all live sessions). `ERR` replaces
  the last row when any live session is in error, even if waiting has priority.
  Zero rows are dim; values over 99 show `99+`. These are observed counts, not
  progress percentages, attempt counts, or a claim that all work has completed.
- **Conversation scenes**: the reader's own turn is what the panel is for. When a
  user message reaches a live session (`chat_start`, not automated), that agent's
  official creature appears listening under `HEAR` until its reply lands or one
  minute passes, while the session is processing (a turn close also clears it);
  after that the `WORK` summary carries the rest of the turn. `HEAR` reports your
  message arriving — it never means the agent is asking you anything; a question
  for you is `WAIT`. It was `ASK` with a ten-minute hold until 2026-10-08, and a
  long run read as a pending question. The reply (`chat_response`, not automated)
  holds the stage for six seconds under `SENT` (answer delivered, not input
  requested) with a speech bubble. Automated turns (crons) and bare task closes
  are not conversations; a task close still gets the six-second result scene.
  A newer turn or removal from the live roster cancels the reply scene.
  The Timebox face mirrors both: a listening face, then a talking face.
- **Session identity**: rows and roster use two id forms — an observed session is
  `observed:<agent>:<uuid>` in the roster and the bare uuid on its timeline rows,
  and OpenClaw is one `openclaw-gateway` presence whose rows carry per-agent keys
  (`openclaw:agent:main:main`). Both engines match rows with `matrixRowSession`
  (either id form; OpenClaw by agent), and a result whose session has already
  left shows the creature its row names. Until 2026-10-08 an exact-id match sent
  every observed session and OpenClaw to the neutral square face on DONE/SENT/ASK.
- **Event scenes**: a new live session gets a six-second official-creature entrance
  (a conversation outranks it). Then the numeric summary
  returns. There is no decorative creature carousel. Waiting/errors preempt both
  scenes and show the affected creature with `WAIT`/`ERR` and the affected count.
  Multiple affected sessions rotate in stable ID order every six seconds; cleared
  sessions leave the rotation immediately. Quota usage never causes an error. Initial/reconnected rosters establish
  a baseline rather than replaying entrances. A burst coalesces to one entrance.
  The bottom event-scene dots show up to eight live session states (overflow is
  marked); unknown agents use a neutral resident, never another agent's logo.
- **Parity**: `shared/src/matrix-expression.ts` owns state/timing policy;
  `bridge/src/pixoo/matrix-art.ts` owns the art. `pnpm generate-matrix-expressions`
  bakes Swift RLE frames, and executable Node/Swift tests compare event sequences
  and RGB pixels. Missing roster data shows `SYNC`, separately from an empty
  roster and the existing transport `OFFLINE` badge. Pixoo64 is unchanged.
- **OFFLINE badge**: the CLI client paints it only after the daemon has been
  unreachable for 15 seconds (`OFFLINE_GRACE_SEC`). A single missed 3-second frame
  request is "could not look", not "offline"; painting on it made iDotMatrix alone
  flicker OFFLINE, since the Timebox client never did.
- **Output tuning**: conservative 1.22 brightness / 1.08 contrast compensation in both native and CLI paths; the former 1.6 / 1.2 boost washed out defining holes.
- **Constraint**: one BLE connection per daemon; brightness command range 5–100%.

### Divoom Timebox Mini

The Timebox Mini drives an 11×11 LED screen over **BLE**. A `timeboxDevices` entry carries the BLE `address`; `agentdeck timebox scan` discovers `TimeBox-mini-light` peripherals and `add <address>` registers one.

- **BLE** — BLE GATT over the ISSC transparent-UART service `49535343-fe7d-…` (write char `49535343-8841-…`, write-without-response, 20-byte chunks). Advertises as `TimeBox-mini-light` (sharing its BD_ADDR with the Classic audio endpoint `TimeBox-mini-audio`). Driven by `sync_ble.py` (bleak) on the CLI daemon **and natively by the App Store Swift daemon over CoreBluetooth** (no subprocess). (The legacy Bluetooth Classic SPP variant was removed — poor macOS compatibility, no App Store path.)

- **Rendering — agent face**: both daemons render the same native 11×11 robot
  face (`renderMatrixFace`, `bridge/src/pixoo/matrix-art.ts`; Swift replays the
  generated frames). It represents the whole desk, never a particular provider.
  Fifteen faces, each with its own 4-bit signature:

  | Situation | Face |
  |---|---|
  | No roster yet (startup, link reset) | `unknown` — dim broken eyes |
  | Live daemon, zero sessions | `empty` — sleeping eyes and a "Z" |
  | Sessions, nothing running | `idle` — dim grey eyes that glance and blink |
  | Agent working | `working` — cyan eyes that glance |
  | Parent idle, subagents running | `delegating` — heavy-lidded cyan eyes looking down at the helpers |
  | CI wait (queued/running) | `ci` — eyes rolled up at a filling ellipsis; a CI wait is neither PERM nor WORKING |
  | CI wait, phase unknown | `ci-unknown` — the same pose in grey, ellipsis still |
  | Needs approval | `waiting` — amber raised brows, wide eyes, asking mouth |
  | Needs a choice | `choosing` — amber brows, pupils darting, pressed lips |
  | Review a diff | `reviewing` — amber brows, narrowed reading eyes, small "o" |
  | Failed session, or Gateway health error while the OpenClaw session is present | `error` — red frown |
  | Explicit result / reply / question / new session | `done` · `reply` · `asked` · `arrival` |

  The bottom row stays clear: population counts are not drawn beneath the
  face. Delegated work is expressed through the downward scanning eyes.
  Only amber pulses. Quota is not on the face (it is not a session state; DESIGN.md §2.8).
  The daemon gone entirely is the separate OFFLINE badge, and host display
  sleep scales or blanks brightness without changing the face.
- **Conversation motion**: a message turns the pupils toward the reader and
  earns a small listening nod. Replies move through closed, open, rounded and
  smiling mouth shapes; a new session wakes and winks hello. Quiet/work/reply
  faces have restrained warm cheeks and some open eyes carry sand highlights,
  all from existing design tokens. Eyes and mouth retain their
  status hue; error, unknown, CI and needs-you faces keep their sober palette.
  Major gestures hold for two 750 ms frames so the CLI's nominal 1.5 s polling
  cannot freeze the speaking mouth by sampling only alternate frames. This is
  a response to session/timeline events, not microphone, camera or touch input.
- **Priority**: no roster → needs you (approval → choice → diff, a fixed order,
  never a timer) → error → conversation / new session / a result in its first
  six seconds → working → delegating → CI wait → a result within 90 seconds →
  empty → idle. Live work replaces a result smile after six seconds; the
  iDotMatrix result count keeps its 90-second window. Aborted, denied, pending
  or future events do not count. The BLE packet format is unchanged.
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
