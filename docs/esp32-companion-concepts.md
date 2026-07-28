# ESP32 companion concepts — T-Embed CC1101 and T-Display-S3-Pro

This began as the promotion study for two Evaluation boards and now serves as
the design record for their **Shipping** roles in the
[hardware compatibility sheet](hardware-compatibility.md). Implemented sections
are marked with dates; exploratory sections remain proposals. The premise is
unchanged: neither board should be a port of an existing dashboard — each earns
its place by doing something the current fleet cannot.

The single most important fact shaping both concepts: **the daemon already speaks a complete steering vocabulary** on port 9120 — `focus_session`, `navigate_option`, `select_option`, `session_command{escape|interrupt|respond}`, `review_run`, `permission_decision` (`bridge/src/daemon-server.ts`). The Companion Knob now drives that same vocabulary used by the Stream Deck plugin, Ulanzi plugin, and ips10 touch mosaic; the Focus Strip observes its shared focus. Core steering therefore needs **no board-specific command types**.

## T-Embed CC1101 — "Companion Knob"

> **Status (2026-07-27): Shipping and hardware-verified.** Docked steering,
> battery pager/chime, fuel gauge, NFC, IR receive, encoder push-to-talk,
> host STT→session routing, and spoken replies through the board speaker are
> implemented. BLE phone relay and CC1101 sub-GHz capture remain future work.

The compatibility sheet already states the thesis: the T-Embed is the only unit in the fleet with a rotary encoder and the only bidirectional-input candidate — every Shipping board is output-only apart from touch. A rotary encoder is exactly the shape of the existing steering vocabulary: rotate = move a cursor, press = commit, long-press = back. The board is a **dual-mode companion**: docked on the desk it is a steering knob; unplugged it is a battery pager you carry around the house.

### Interaction grammar (both modes)

The grammar is the Stream Deck session-centric two-level UX ([streamdeck-layout](streamdeck-layout.md): list level = enter a session, detail level = state-dependent commands, BACK = leave) translated to an encoder. It reuses the `buildSessionDeck` concept from `@agentdeck/shared` rather than inventing a new layout model.

| Input | List level | Detail level (focused session) |
|---|---|---|
| Rotate | Cycle sessions | Move option/command cursor (`navigate_option`) |
| Short press | Enter session (`focus_session`) | Commit (`select_option` / state command) |
| Long press | — | BACK / cancel (`session_command{escape}`) |

Detail-level commands are state-dependent, mirroring the Stream Deck grammar: an **awaiting** session exposes the real parsed options (approve/deny, AskUserQuestion choices); a **processing** session exposes STOP (`interrupt`); an **idle** session exposes GO ON / REVIEW (`review_run`) — making the knob the minimum viable steering device for a desk without a Stream Deck.

### Mode A — docked steering knob

USB-powered on the desk. At list level the 1.9″ 320×170 panel is a visual
carousel: the selected session's canonical agent creature occupies the center,
the previous/next creatures peek from the sides, and project/state/context sit
below it. One encoder detent therefore changes a silhouette before it changes a
line of text. Pressing enters the selected session's readable command detail.
The 8× WS2812 ring is a session-status ring — up to eight sessions, one LED
each, colored with the semantic status tokens. Per the design system rule,
**only amber awaiting animates**; kelp and coral stay static.

### Mode B — portable pager

On its 1300 mAh battery the board roams the local WiFi. The panel sleeps; the ring and speaker stay armed. When a session enters a genuine response-wait (derived from the awaiting fields already present in `sessions_list` — `question`, `promptType`, `options`; no new event needed), the ring pulses amber and the speaker plays a short chime. The holder answers on the spot with the encoder: rotate through the options, press to commit. Power discipline follows the display-sleep contract (off must be dark, min must stay legible; heartbeat re-sync guards against a lost wake edge), with a relaxed WS keepalive interval while asleep. The BQ27220 fuel gauge reports battery percentage through `device_info`/status so the dashboard's downstream rail can show charge state.

**Phone-paired transport (BLE)**: portable range today is bounded by the board's own WiFi association. A second transport — a BLE GATT link to the iOS/Android AgentDeck app, with the phone relaying frames to the daemon over its existing paired WS — buys three things: **battery** (BLE idle draw is a fraction of WiFi's, and idle draw is what actually decides pager standby time), **roaming that follows the phone** instead of AP coverage, and **pairing UX inside the app** instead of `agentdeck wifi-setup`. The steering command set is tiny (a cursor and a commit), so it fits BLE comfortably. Honest boundary: this is not internet-wide remote control — the phone must still reach the daemon on the local network; AgentDeck has no cloud relay and this concept does not add one. The app-side relay also needs an [appstore-feature-matrix](appstore-feature-matrix.md) tier decision before implementation touches the apps.

### Mode C — voice remote (staged)

- **Stage 1 (shipped)**: the speaker doubles as the pager chime, and
  press-and-hold triggers the daemon-owned push-to-talk pipeline.
- **Stage 2 (on-device wake word)**: the dormant `esp32/src/audio/wake_word.*` path (`BOARD_HAS_AUDIO`, currently defined in no env) is the revival candidate, using the onboard mic for local inference only — hands-free arming for stage 3 without streaming anything by default.
- **Stage 3 — shipped 2026-07-26 (capture + transcribe + route)**: hold the
  **encoder at list level**, speak, release. The CC1101 variant has no exposed
  side key; power-off therefore lives in the detail menu. The board streams
  PCM16 over **binary WS frames** bracketed by `voice_begin`/`voice_end` (never
  the ~200-byte text outbox); the daemon assembles a WAV, transcribes it with
  Apple's on-device recognizer through the bundled Swift helper, echoes
  `voice_result` back for the screen, and routes the text as a prompt to **the
  session the knob was pointing at**. Transcription locale is `voice.locale` in
  settings.json; without it the recognizer uses the system locale. Delivery is
  hardware-verified for observed sessions of any agent. The reply is synthesized
  to 16 kHz mono on the host and streamed to the board amplifier; USB transport
  carries the same PCM base64-wrapped in line-delimited JSON. Code-only answers
  are announced rather than read aloud.
- **Stage 3 original sketch**: press-and-hold (or wake word), speak a question, release. The board streams mic audio to the daemon over a **binary WS side-channel** (the ~200-byte text outbox is explicitly not this path; PCM16 mono at 16 kHz is well within WiFi budget), host-side STT turns it into a prompt for the focused session — or a dedicated lightweight ask-agent when nothing is focused — and the reply comes back as host-side TTS audio streamed to the speaker, with the reply text mirrored on the panel. The board contributes exactly a microphone, a speaker, and a button; every heavy stage (STT, agent, TTS) stays on the host. Cost-sensitive defaults apply end to end: on-host local engines by default, API engines opt-in.

### Peripheral primitives — ship the floor, explore the ceiling

The NFC, IR, and sub-GHz radios are neither parked nor given bespoke features up front. Instead the firmware ships **raw primitives** behind one generic peripheral surface, so exploration happens on real captured data instead of speculation:

- **Capability advertisement**: `device_info` gains a capabilities list (`nfc`, `ir_rx`, `ir_tx`, `subghz_rx`, `audio`, `battery`) so the daemon and dashboard know what a board can do without board-name special-casing.
- **`peripheral_event` (device→daemon)**: one frame shape for everything the board senses — `{kind:"nfc_tag", uid}`, `{kind:"ir_rx", protocol, code}`, `{kind:"subghz_rx", freq, rssi, code}`. Events surface in the dashboard (diag/timeline) and are mappable to **existing** commands through user config: tag X → `focus_session`, remote button Y → `select_option`, tag Z required before `permission_decision{allow}`.
- **IR receive (shipped 2026-07-26)**: `IRremoteESP8266` on the vendor pins (EN GPIO2 must be driven high first), decoding standard protocols and emitting `{kind:"ir_rx", protocol, code}`. Unknown-protocol frames are dropped rather than mapped — their value is a rolling hash, not a stable code — and a held button's ~110 ms repeat burst collapses into one event. Any remote in the room becomes an AgentDeck button once mapped.
- **Sub-GHz receive: deliberately deferred.** Catching ordinary 433 MHz remotes means raw OOK timing capture plus protocol decode (the Flipper problem), and the CC1101 shares the SPI bus with the panel, so it needs careful CS arbitration against LVGL flushes. The `subghz_rx` frame shape already exists for when that work happens.
- **`peripheral_command` (daemon→device)**: the actuation mirror — `{kind:"ir_tx", code}` replay of a code the user previously captured, plus ring/chime test frames.

**Mapping (shipped 2026-07-26)**: `settings.json` carries a `peripheralMappings` array — `{kind, uid|code, action, project?}` where `action` is `focus` / `approve` / `deny` / `review` / `stop`. The daemon resolves a tap to one of the steering commands it already speaks; omitting `project` targets whichever session most needs a human (awaiting, then processing). An unmapped tap is logged with its uid so the user can discover it and add a rule — physical tricks are configuration, never firmware policy.

Applications then become config mappings rather than firmware work: NFC tags as **project bookmarks** (tap to focus) or as a **physical second factor** for dangerous permission approvals; any cheap 433 MHz remote as extra AgentDeck buttons anywhere in the house; a captured IR code replayed when a session completes ("turn the desk lamp green"). Boundary: **sub-GHz stays receive plus replay-of-own-captured-codes only** — no arbitrary transmit, both for radio-band compliance and because scan/capture already covers the exploration value.

The identity to protect: this board is not another display. It is the fleet's only *input* device — and with these primitives its only sensor/effector — and every design choice should defend that.

### Refinement directions (2026-07-25, from external ideation)

A ten-concept external study of the T-Embed form factor ("AI ORBIT CONTROLLER") was reviewed against this architecture. What it validates, what it adds, and what stays out of scope:

**Adopted — maps onto existing wiring:**

- **INTENT (autonomy dial)** — the strongest addition. "Click-then-rotate adjusts how boldly the agent acts" maps directly onto machinery AgentDeck already has: Claude Code **permission modes** (default / acceptEdits / plan / bypassPermissions) are switchable today via the routable `switch_mode` command (the Shift+Tab convention), **effort level** already travels in the state stream, and the model choice already has a daemon-side answer in the APME Pareto **Recommend**. A detail-level "Autonomy" menu entry — rotate through mode/effort steps, press to apply — turns the knob into the physical steering wheel for *how* an agent works, not just *what it does next*. No new protocol; managed PTY sessions only at first (observed sessions can't switch modes).
- **RESUME (timeline scrubbing)** — rotate to scrub the focused session's milestone history. The daemon already serves exactly this via `query_session_timeline` (session-scoped `timeline_history` backfill); the knob adds a read-only "scrub" sub-view in detail mode. Checkpoint *jumping* stays out (no such primitive), but scrub + read is a natural encoder gesture.
- **WHISPER (voice capture → next action)** — refines voice Stage 3: a captured utterance doesn't have to open a live Q&A; routed through the existing turn-end **directive queue** (`send_prompt`), a spoken thought becomes the session's next instruction. "Speak → pick target session with the dial → queued" is the AgentDeck-native version of the study's idea-inbox.
- **RELAY (work-token framing)** — not a feature but the right *mental model* for the grammar we shipped: STOP = take the baton, options/approve = answer and hand it back, Go on = hand the baton to the agent. Worth adopting in copy and docs.
- **Screen discipline** — the study's four-line rule matches this panel: *who is working, what they're doing, how far along, what I can do*. The list-level card already approximates it; treat it as the explicit acceptance test for every future knob screen.
- **ORBIT (radio-channel switching)** — validates the shipped list level (rotate = cycle sessions, ring = fleet state). One deviation stays deliberate: "needs human" pulses **amber**, not red — semantic status colors are a design-system invariant.

**Noted for later phases:**

- **PROBE** (environmental sensing via Grove/GPIO) folds into the peripheral-primitives plan — sensors would ride the same `peripheral_event` frame; no bespoke mode.
- **TUNE** (continuous generative-parameter tuning) — the encoder-as-continuous-controller insight is sound, but AgentDeck has no generative-parameter surface; the INTENT dial is its coding-agent translation.

**Out of scope (not AgentDeck's product):** TURN (meeting facilitation), COMPASS (personal direction), SIGNAL (presence totem) — desirable products, different product. Recorded so they are not re-litigated here.

Hardware caveat: the study describes the **base** T-Embed (7-LED ring, dual mic, 1200 mAh, no radios). The on-hand unit is the CC1101 variant — 8-LED ring, single mic + speaker, 1300 mAh, plus the NFC/IR/sub-GHz set — so counts and peripherals in the spec sheet stay authoritative.

## T-Display-S3-Pro — "Focus Strip"

The 2.33″ 480×222 wide strip is the wrong shape for a terrarium and the right shape for a **Focus Strip**: an always-on surface below the monitor or in front of the keyboard. It is a stationary desk fixture (USB-powered; the 470 mAh cell only bridges cable swaps).

Three direct pages ship. The split rocker (`GPIO12/16`) moves previous/next,
`BOOT` (`GPIO0`) returns to or confirms Focus, and the fourth physical button,
`RST`, remains an unconditional hardware recovery path. Touch mirrors the
rocker with horizontal swipes and exposes three direct header tabs:

In landscape, short 44 px live key capsules sit directly beside the matching
buttons near the right end of the two long edges. In landscape, the upper pair
is previous-page + next-page from left to right; the lower pair is power icon +
Focus from left to right. Page destinations update as compact `SESS` / `USAGE`
/ `FOCUS` labels and the pressed app key briefly lights cyan. The power/reset
button is shown only as a power icon, matching the visible screen-off result
rather than exposing the electrical reset name.
The labels and widgets are static/flash-backed so this spatial affordance does
not add render-loop allocation.

- **Focus** — one prioritized session and one readable thought. Awaiting input
  owns the page and renders separate, labelled **Deny** and **Approve** touch
  targets. Generic taps and holds never answer a gate. Otherwise the explicit
  daemon focus wins, followed by processing and roster fallback.
- **Usage** — Claude and Codex quota windows (5 h primary, 7 d secondary) as full-height gauges with reset countdowns: the permanent large-format version of the Stream Deck E2/E3 dials. Gauges follow the established gauge grammar: full fill, sharp stage colors, white numerals.
- **Sessions** — the three highest-value rows (awaiting, explicit focus,
  processing, then roster order), with project and latest milestone. This
  deliberately replaces the earlier five-row tiny-text layout.

Touch is first-class navigation: tap a header tab, swipe between pages, or tap a
Sessions row to focus it. The **LTR-553 ambient light sensor** makes this the
first board where the display-sleep contract gets a sensor input — brightness
follows room light and the strip dims itself at night, handled entirely locally.
The SY6970 charger has no coulomb-counting state-of-charge register, so its
header reports the continuously sampled **cell voltage and charge state** rather
than presenting an invented percentage. Note the V1.1 backlight constraint from
the spec sheet: constant-current drive with 16 levels,
`USING_DISPLAY_PRO_V1` must stay undefined on the on-hand units.

**Desk-set pairing (implemented 2026-07-27)**: entering a session on the
Companion Knob sends `focus_session`; the daemon's `focusedSessionId` is retained
by the ESP32 state model, so the Focus Strip immediately follows that session
and marks it in Sessions. A genuine response-wait still outranks focus. External
focus broadcasts also move the Knob carousel once without fighting subsequent
local rotation.

### CAM page — show-and-tell capture (implemented 2026-07-27)

The camera shield faces **backward**, which killed the original presence idea
(you can't watch a user with a rear camera) and revealed the right role: the
fleet's first **image input channel**. Point the strip at a whiteboard, an app
screen, an error dialog; press the shutter; the target session gets a prompt
with the saved file path — the visual counterpart of the knob's dictation.

- **Wire**: one `POST /esp32/photo` carrying the whole JPEG. Chunking was
  tried first (a `photo_begin` / frames / `photo_end` clone of the voice
  bracket) and lost photos two ways on this board — the HWCDC drops whole
  64-byte FIFO blocks, costing ~2 of 10 base64 lines per upload regardless of
  pacing, and the WS client's TX jammed after the first binary frame. A JPEG
  with a hole is worthless, so the byte-count guard refused them all. TCP
  already solves ordering and retransmit, so the image rides a plain HTTP
  body; the chunked paths remain the no-WiFi fallback behind a 20 s deadline
  and an abort diag.
- **Daemon**: assembles the JPEG under `~/.agentdeck/photos/` (retention-swept),
  routes `Look at the photo … {path}` through the same delivery ladder as
  dictated text (observed → terminal injection, managed → `send_prompt`),
  falls back to the daemon-focused session when the strip sent no target, and
  answers `photo_result` — surfaced as strip feedback like `voice_result` is
  on the knob. Template override: `photo.promptTemplate` in settings.json.
  Node daemon only (the injection rung is CLI-tier; matches voice).
- **UI — the shield's presence picks the unit's role.** Camera found at boot
  means this is the handheld unit and it comes up as **Pocket**, a portrait
  222×480 phone UI: LVGL pointer indev (so the session list scrolls with
  momentum instead of the landscape gesture layer's page flips), tap a card to
  focus, tap the CAM target bar to cycle which session receives the shot,
  bottom nav plus rocker for tabs, BOOT for camera/shutter. No camera keeps the
  landscape Focus Strip and its CAM-less three pages. One binary decides at
  runtime. SCCB rides Wire's I2C port (no second driver on the shared bus);
  pixel data uses the dedicated DVP pins, so the earlier "capture degrades
  touch" concern shrank to camera bring-up only.
- **Orientation is a measured board fact, not a guess.** The sensor sits 180°
  to the panel in the portrait pose — established by cycling the rotation live
  on the viewfinder, then frozen as a constant. Flipping a CW/CCW flag moves
  the image 180°, so it can never correct a 90° error; three reflashes learned
  that before the rotation became something the eye could land in one pass.
  Because 180° preserves the frame's axes, a capture stays 480×320 while the
  portrait viewfinder centre-crops it — the photo is wider than what was
  framed.
- **Sensor honesty**: the on-hand GC0308 is VGA-class fixed-focus — good for
  whiteboards, layouts, and big error text; not for reading code off a
  monitor. The OV5640 (5 MP, autofocus) drops into the same POGO header and
  the firmware path is sensor-agnostic; swap the shield when that matters.
- **Power discipline**: the camera draws power only between CAM-page entry and
  exit (boot probes then deinits). The first build kept the sensor + 20 MHz
  XCLK running around the clock, and the moment WiFi TX started the 3.3 V
  rail browned out into a reboot loop. The board-level WiFi join fence that
  fell out of that incident is recorded in
  [hardware-compatibility](hardware-compatibility.md) operational exceptions.

**Exploratory — presence moved to the ips10**: on-device presence detection
(never streamed, never stored — on-device only as a hard privacy line) needs a
camera that faces the user. The JC8012P4A1C has one — a front MIPI-CSI 1080p
module — and its ESP32-P4 is the only SoC in the fleet with a hardware ISP.
Sketch: a boolean `peripheral_event {kind:"presence"}` feeding the attention
escalation ladder (user at desk → the strip shows waits quietly; user away →
the knob's pager chime takes over). Blocked on sensor identification (vendor
manual says only "MIPI CSI 1080P"; community reports split between SC2336 and
OV02C10) and on P4 camera driver support in the Arduino toolchain — record in
the gap table before implementation.

## Implementation record and remaining gaps

Closed rows record what made Shipping possible; open rows are deliberate future
work rather than hidden requirements of the current UI.

| Gap | Where | Needed by |
|---|---|---|
| ~~Serial has no device→daemon command channel~~ — closed 2026-07-26 (Node): `handleSerialLine` forwards a command passlist into the same pipeline as WS; Swift twin still device_info-only | `bridge/src/esp32-serial.ts` + Swift twin | Done on Node; Swift pending |
| **NEW capability (2026-07-26): observed AskUserQuestion answered from devices** — the daemon delivers the selection into the session's own host UI. Terminal-hosted (by controlling tty): tmux `send-keys`, iTerm2 `write text` (no focus change), Terminal.app (select tab → key events → restore focus) — all three verified on hardware. App-hosted (Claude.app / ChatGPT.app, no tty): press the AX button matching the option label, else raise → key events → restore focus. No hold, no timeout: an unreachable UI simply leaves the prompt waiting. Tune/verify per host with `agentdeck inject-test --tty <ttysNNN>` / `--app <Name> --label <text>`. Two swallow-bugs fixed en route: the OpenClaw gateway consumed bare session-scoped `select_option`, and serial steering frames were dropped. Node daemon only (App Store Swift daemon spawns no subprocesses — CLI-tier). Known limits: TIOCSTI (the one universal kernel path) is EPERM on macOS outside your own controlling terminal; Electron apps expose no AX tree, so their button rung falls through to key events; emulators without a scripting API (Ghostty, WezTerm, Alacritty, kitty) are only reachable under tmux. | `bridge/src/observed-inject.ts` | Knob + Focus Strip (shipped) |
| ~~`prepareForSerial` strips what the knob needs~~ — corrected 2026-07-25: both daemons already forward per-session `question`/`promptType`/`options`; only `requestId` is missing (neither daemon sends it), so approve/deny run the ips10 fallback (`select_option(0)`/`escape`) until it lands | `bridge/src/esp32-serial.ts` + Swift twin | Knob (works today; requestId later) |
| Firmware outbound frames capped at ~200 bytes (`OUTBOX_LEN`) | `esp32/src/net/ws_client.cpp` | Any `respond`/`send_prompt`-class command |
| ~~No LVGL encoder indev~~ — closed 2026-07-25: the knob consumes encoder events directly (`src/input/encoder.cpp` ISR decode → `ui/knob/` grammar); no LVGL indev/`lv_group` was needed | `esp32/src/ui/knob/` | Knob (done) |
| ~~`device_info` has no capability advertisement~~ — closed: T-Embed advertises battery, NFC, IR, audio input/output and returns battery diagnostics | `shared/src/protocol.ts` + `esp32/src/net/protocol.cpp` | Done |
| ~~No device→daemon peripheral frame~~ — closed for `peripheral_event` + NFC/IR receive/mapping. Daemon→device `peripheral_command`, IR replay, and sub-GHz capture remain open | `shared/src/protocol.ts` + daemon mapping config | RX floor done; actuation/sub-GHz later |
| No BLE link on either end — firmware exposes no GATT service, and the mobile apps have no BLE central/relay role (plus the app-side relay needs a product-tier decision) | `esp32/` + `apple/` / `android/` | Phone-paired portable transport |
| ~~No audio streaming/STT/TTS path~~ — closed: binary WS + base64 serial PCM, host STT→prompt, host TTS→board speaker, and explicit result/error feedback ship | `esp32/src/net/` + daemon voice pipeline | Done |
| ~~No image input channel~~ — closed 2026-07-27: `photo_begin`/`photo_end` + binary WS (base64 `photo_chunk` over serial), daemon save + prompt routing + `photo_result`, strip CAM page. Node daemon only, like voice | `esp32/src/camera/` + `bridge/src/device-photo.ts` | Done (strip) |
| ips10 presence: front-camera sensor part unidentified (SCCB probe needed) and no P4 camera driver in the Arduino toolchain yet — presence `peripheral_event` blocked on both | `esp32/` ips10 env + `shared/src/protocol.ts` kind | Presence phase |
| `apme_*` events remain outside the ESP32 forward filter. The shipping Focus Strip intentionally uses Focus/Usage/Sessions; forwarding is needed only if an exploratory APME page is revived | `SERIAL_FORWARDED_EVENTS` in `shared/src/protocol.ts` | Future only |
| ~~Session-bridge-only `voice` command blocked daemon devices~~ — replaced by daemon-owned `voice_begin`/`voice_end` capture and reply routing | `bridge/src/daemon-server.ts` | Done |
| New-board bring-up is a ~10-step compile-time checklist (board header, env, partitions, `display.cpp`, `main.cpp`, two duplicated board-string ladders, OTA list, docs) | `esp32/` | Both boards |
| ~~No factory-firmware backup for the T-Display-S3-Pro~~ — closed 2026-07-25: 16 MB image captured and spot-verified | [`esp32/backups/MANIFEST.md`](../esp32/backups/MANIFEST.md) | Done |

Design-system constraints carry over unchanged: status colors are semantic and only amber awaiting animates ([DESIGN.md](../DESIGN.md)); brand marks come from the generated masks, never redrawn; both boards would join the counted-surfaces derivation only at promotion time, which is when their spec-sheet rows change status and the surface matrix — not this document — becomes the source of truth.
