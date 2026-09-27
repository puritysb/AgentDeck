# E-ink Face Research — TRMNL 7.5" Voice Interface (Issue #272)

This is a snapshot of issue [#272](https://github.com/puritysb/AgentDeck/issues/272)
("Research: the interface a voice-capable e-ink panel deserves") as of
2026-09-10: what is now measurable on the live daemon, the vendor hardware
facts the issue was still missing for `trmnl_75`, and what remains open. It is
a research write-up, not a spec — the shipped face-set decision lives in
[E-ink Surface Contract](eink-surface-contract.md), which this document does
not restate wholesale and does not modify.

**Scope note.** By the time this was written, most of the issue's own
"candidate face set" step had already shipped (`esp32-v1.2.0`, commits
`2858ccbd`/`f29e09a9` and the 2026-09-01/02 field-review rounds cataloged in
the issue's comments). What had **not** been done is the issue's own first
step — *measure before redesigning* — and the `trmnl_75`-specific hardware
row (mic path, speaker amp, button deep-sleep wake). Those are this
document's actual contribution.

## 1. What is measurable now, and what still is not

### 1a. Frame-push volume: measurable now, from a live counter — not from logs

The task brief for this research assumed the daemon's own push decision (a
content-hash/frame-sig gate, analogous to the `?sig=` conditional on the pull
`/glance-frame` HTTP endpoint) might be visible in `~/.agentdeck/daemon-stderr.log`.
It is not, for a structural reason: `trmnl_75` is a **push** panel reached
over the same `WsServer.broadcast()` call as every other WS client (Stream
Deck plugin, TUI, Android, iOS) — the daemon does not diff fields or decide
"does this board need a repaint" per board. It broadcasts the raw protocol
event to everyone, and the pushed board's own on-device `paperHash`/`contentHash`
(`esp32/src/ui/eink/eink_display.cpp`) decides whether to actually redraw.
`WsServer.broadcast()`'s one debug line (`broadcast(<type>) to N clients`) is
gated behind `--debug`, which was not enabled during the 20-day production
window covered by `daemon-stderr.log` on this Mac (Aug 21 – Sep 10) — so it
recorded zero relevant lines, confirming the gap rather than filling it.

What **is** already measurable, without any new instrumentation, is the
on-device repaint counters shipped alongside the face-set redesign itself
(`device_info.repaintCount` / `fullRefreshCount`, [E-ink Surface Contract §6](eink-surface-contract.md#6-evaluation-telemetry)),
exposed by the Node daemon over both serial and WiFi and readable live from
`GET /health` (`modules.esp32Wifi.devices[]`, `modules.serial.connections[].deviceInfo`).
Querying the daemon on this Mac (port 9120, bearer token from
`~/.agentdeck/auth-token`) on 2026-09-10 found one live `trmnl_75` board
(reported as `inkdeck` — it has not yet taken the `008b029a` rename OTA),
serial port `/dev/cu.usbmodem1CDBD474F4D81`, WiFi `192.168.68.75`:

| Field | Value |
|---|---:|
| `buildHash` | `7e8c232b-dirty` (2026-09-01, post-facelift; predates the same day's later polish commits `9f1b6c4d`…`4376b97e` and the `008b029a` rename) |
| `uptimeSec` | 768270 s (8.89 days, no reboot) |
| `repaintCount` | 5152 |
| `fullRefreshCount` | 1671 |

Derived rates:

| Metric | This measurement (post-facelift, 8.89 days) | Issue's own 24h measurement (pre-facelift, `fae46ef0`) | Change |
|---|---:|---:|---:|
| Repaints / day | 579.4 | 2757 | **4.8× fewer** |
| Full (flashing) refreshes / day | 187.9 | 461 | **2.4× fewer** |
| Mean gap between full refreshes | 7 min 40 s | median 30 s (tightest decile 18–19 s) | mean gap now approaches the panel's own 10-minute criterion; the old figure never got close |
| Full refreshes as % of all repaints | 32.4% | 16.7% (461/2757) | proportion of repaints that are full rose, but the *absolute* full-refresh rate still fell 2.4× |

**Caveats, stated rather than smoothed over:**

- This is one board's cumulative counter since its last boot, not a
  resettable 24-hour window — comparing a mean gap over 8.89 days to the
  issue's own **median** over a single 24h window is directional, not
  apples-to-apples. A same-shape 24h/percentile re-run (the SQL + replay
  method in the issue's own handoff comment, but reading `repaintCount` deltas
  instead of reconstructing from `apme.sqlite`) would be the cleaner
  follow-up.
- The counters are undifferentiated totals — they do not say which **face**
  (`DECISION`/`ANSWER`/`DIGEST`/`GLANCE`/`ROSTER`) produced each repaint, so
  they cannot reproduce the issue's own "how long does a painted image
  survive" percentile table. That is a real regression in measurability
  versus the issue's original method, traded for something the panel can
  report about itself without replaying logs — see §1b.
- The measured build (`7e8c232b`) is 9 days behind the branch tip
  (`008b029a`, 2026-09-08) and does not include the same day's later polish
  commits. The numbers describe "the facelift is live", not "every polish
  commit through 2026-09-08 is live" on this specific unit.

### 1b. Actionability of a push: not measurable, even now — one line added

Frame-push *volume* is measurable (§1a). Frame-push *content* — of the events
the daemon actually pushes to a board like `trmnl_75`, how many carried
something a human could act on versus something cosmetic — is not, because
`WsServer.broadcast()` has no such classification at all: it forwards the
`BridgeEvent` verbatim to every WS client. Per the task brief, this document
adds the one line that would make it answerable, without changing what is
pushed:

- `bridge/src/ws-server.ts` — `broadcastActionability(event)`, a pure
  classifier: a `state_update` or `sessions_list` event is `'actionable'` if
  it carries a session in `AWAITING_PERMISSION` / `AWAITING_OPTION` /
  `AWAITING_DIFF` (the same states an approval or `AskUserQuestion` would
  produce), `'cosmetic'` otherwise, `'n/a'` for event types with no session
  state. The one call site (`WsServer.broadcast()`'s existing debug line) now
  reads `broadcast(<type>) to N clients actionability=<actionable|cosmetic|n/a>`.
- Test: `bridge/src/__tests__/ws-server-broadcast-actionability.test.ts` —
  the classifier's truth table, plus two tests that call `WsServer.broadcast()`
  through a mocked logger and assert the line actually fires with the right
  verdict (mutation-checked: reverting the log-line edit fails both).

### Cumulative measurement without debug logs

The Node daemon's authenticated or same-machine `/health.broadcastMetrics`
now exposes server-wide broadcast attempts. The unauthenticated LAN health
response remains unchanged; Swift does not yet expose these metrics. Missing
metrics mean unavailable, not zero traffic.

`instanceId` identifies one WsServer lifetime; `startedAt` and `capturedAt` are
integer epoch milliseconds. `elapsedMs` uses a monotonic clock. `actionable`,
`cosmetic` and `unclassified` count the classifier outcomes above; `total` is
their sum. Each broadcast counts once, even with no clients, failed sends, or
multiple awaiting sessions. Direct per-client sends are excluded. These are
attempts before client transforms, not successful deliveries, unique decisions,
per-board events, or panel repaint counts. No session content is retained.

For a 24-hour window, save two selected metric snapshots and subtract their
counters only when `instanceId` matches and the elapsed interval covers the
window. A restart starts a new interval; never subtract across identities.
Compute awaiting-content share as `deltaActionable / (deltaActionable + deltaCosmetic)`,
excluding unclassified events; a zero denominator is
unavailable. Pair this with the board's own repaint/full-refresh counters and
uptime, independently rejecting intervals in which the board restarted.
Do not save the entire `/health` response, which also contains credentials.

This makes interval totals available without turning on verbose logging; it
does not supply repaint percentiles or complete the field measurement in #272.

## 2. Hardware table — TRMNL 7.5" (`trmnl_75`)

Sourced from Seeed's own product/wiki pages (cited per row) and, where the
vendor is silent, from AgentDeck's own board header and `platformio.ini`,
called out explicitly as firmware fact rather than vendor fact.

| Field | Value | Source |
|---|---|---|
| Kit | Seeed TRMNL 7.5" (OG) DIY Kit — XIAO ePaper Display Dev Board + XIAO ESP32-S3 Plus driver | [Seeed product page](https://www.seeedstudio.com/TRMNL-7-5-Inch-OG-DIY-Kit-p-6481.html) |
| MCU | ESP32-S3, dual-core Xtensa LX7 @ 240 MHz | [espboards.dev XIAO ESP32S3 Plus](https://www.espboards.dev/esp32/xiao-esp32s3-plus/) |
| SRAM | 512 KB | espboards.dev (above) |
| Flash | 16 MB physical (DIO mode) | espboards.dev (above) — **but** AgentDeck's `platformio.ini [env:trmnl_75]` pins `flash_size = 8MB` because the `seeed_xiao_esp32s3` Arduino BSP bakes an 8 MB flash-size field into the 2nd-stage bootloader; a 16 MB partition table is rejected at boot. This is a firmware/BSP constraint, not a vendor spec — AgentDeck's own `esp32/boards/board_trmnl_75.h` records the same finding. |
| PSRAM | 8 MB, Octal (OPI) | espboards.dev (above); matches `-DBOARD_HAS_PSRAM` and the 8 MB figure in AgentDeck's own board header/platformio.ini |
| Panel | 7.5" monochrome e-paper, 800×480, partial refresh 0.34 s / full refresh 3.5 s | [Seeed TRMNL 7.5" wiki](https://wiki.seeedstudio.com/trmnl_7inch5_diy_kit_main_page/) |
| Panel controller | Good Display GDEY075T7, UC8179 driver | AgentDeck's own `esp32/boards/board_trmnl_75.h` (not itemized on the vendor spec table; the panel model is named on Seeed's wiki, the controller chip is AgentDeck's own bring-up finding) |
| Buttons | `KEY1` = GPIO2 ("Next page" in Seeed's own ESPHome example), `KEY2` = GPIO3 ("Previous page"), `KEY3` = GPIO5 (present on the board; Seeed's own example leaves it commented out/unused, and AgentDeck's firmware does not wire it either). `RESET` is a hardware reset, not programmable. | [Seeed ESPHome Cookbook for this kit](https://wiki.seeedstudio.com/ogdiy_kit_works_with_esphome/) |
| Button deep-sleep wake | **Not stated by vendor for KEY1/KEY2/KEY3 specifically.** Seeed's own ESPHome deep-sleep example wakes on a *different* pin — `wakeup_pin: GPIO4` (`INVERT_WAKEUP`) — which is not one of the three keys. On AgentDeck's own board wiring, GPIO4 is already claimed as `BOARD_PIN_EPD_BUSY` (the e-paper busy line), so Seeed's own worked example is not reusable as-is on this firmware without picking a different wake pin. Whether GPIO2/3/5 are individually RTC/EXT1-wake-capable on the ESP32-S3 is a chip-level fact, not something either vendor doc states for this board, and is left unverified here rather than assumed. | Seeed ESPHome Cookbook (above); AgentDeck `esp32/boards/board_trmnl_75.h` |
| Microphone | **None onboard.** The XIAO ESP32-S3 *Plus* (used here) has no microphone — only the separate "Sense" variant (a different SKU, with an OV2640 camera and PDM digital mic) carries one. The Plus exposes a bare I²S port on its castellated back pads (GPIO38–40), but nothing is wired to it on this board; there is no PDM/I²S microphone, codec, or amplifier populated on either the XIAO Plus or the TRMNL 7.5" carrier board. | [espboards.dev XIAO ESP32S3 Plus](https://www.espboards.dev/esp32/xiao-esp32s3-plus/); cross-checked against the XIAO ESP32S3 **Sense** listing, which is the SKU that *does* carry a mic — confirming the Plus does not |
| Speaker / amplifier | **None onboard, not mentioned by either vendor doc.** | Seeed TRMNL 7.5" wiki; espboards.dev XIAO ESP32S3 Plus |
| Power | USB-C, native TinyUSB CDC (no serial-converter chip needed) — matches AgentDeck's own `ARDUINO_USB_MODE=0` / `ARDUINO_USB_CDC_ON_BOOT=1` build flags. The **kit itself** additionally ships a 2000 mAh Li-ion battery on a JST connector, vendor-rated "3-month battery life in deep sleep mode" at a 6-hour refresh interval — i.e. deep sleep with periodic wake is a vendor-supported mode of this hardware. AgentDeck's current firmware does not use it: `trmnl_75` is deployed always-USB-powered, and `BOARD_PIN_VBAT_EN` / `BOARD_PIN_VBAT_ADC` are defined in the board header but unused. This is a **deployment choice**, not a hardware limitation. | espboards.dev (XIAO charge circuit: 100 mA fast-charge / 0.9 mA trickle, 3.7 V LiPo pads); Seeed TRMNL 7.5" wiki (kit battery + deep-sleep rating); AgentDeck `esp32/boards/board_trmnl_75.h` comment "Battery telemetry (unused — TRMNL 7.5" runs USB-powered)" |

## 3. The two structural claims, for this board specifically

The issue's draft comment already states these; restated here with what they
imply for `trmnl_75` in particular, which is the one board in the fleet that
is unambiguously **push** (always-USB-powered, always-on WS) rather than
**pull**.

**Claim 1 — the panel holds one thing, so the selection rule is the interface.**
For a pull/battery board, "what wins the screen" is partly answered by
*when* the board is even awake to ask. `trmnl_75` has no such escape hatch:
it is reachable at every moment, so the arbitration rule
(`DECISION > ANSWER > DIGEST > GLANCE > ROSTER`, already shipped in
[E-ink Surface Contract §4](eink-surface-contract.md#4-arbitration-and-holds))
carries the full weight of "is this worth interrupting the resting face for"
with no power-budget excuse to fall back on. §1a's measured 2.4× drop in
full-refresh rate is that rule paying off in practice, not just in theory.

**Claim 2 — body vs band, because e-ink charges by area.** `trmnl_75`'s
`MIN_REFRESH_INTERVAL_MS` (3000 ms) and `FULL_EVERY_N_PARTIALS` (5) are
**unchanged** from before the facelift (`esp32/src/ui/eink/eink_display.cpp`)
— the win in §1a did not come from a rate-limit tuning knob, it came from
what counts as a "real" content change in the first place. The old, single
ROSTER-style `contentHash` hashed `currentTool`/`activity`, fields that move
on every tool boundary; the shipped `paperHash` for `GLANCE`
"deliberately ignores live tool/activity churn" and only moves on session
state, a durable milestone, counts, or integer usage movement. That is
Claim 2 applied literally: the *band* (a status word, never baked into the
repainted body) absorbed the churn that used to force a body repaint.

## 4. Face set — what shipped, and what a voice grammar still needs

The five-face set, its admission contract, and its arbitration/hold rules
are **shipped and are not re-derived here** — see
[E-ink Surface Contract §2–4](eink-surface-contract.md#2-face-definitions).
Board binding for `trmnl_75` specifically
([§5](eink-surface-contract.md#5-board-binding-and-invariant-controls)):
push delivery mode (`{DECISION, DIGEST, GLANCE, ROSTER}`; `ANSWER` is
reserved for a voice turn and retired as an automatic face on 2026-09-28), no PTT (no microphone — confirmed again by §2 above),
`KEY1` cycles durable pages, `KEY2` returns to `GLANCE`.

What that leaves for *this issue* — the voice-capable interface — is
everything downstream of "there is no microphone yet":

| Face | Trigger (as shipped) | Hold / duration (as shipped) |
|---|---|---|
| `DECISION` | A session enters `AWAITING_PERMISSION`/`AWAITING_OPTION`/`AWAITING_DIFF` with structured options or a request ID | Preempts an unheld body immediately; held for 8 min once a user acts, then re-arbitrates |
| `ANSWER` | Retired as an automatic face (2026-09-28): switching on every landed reply replaced the board unprompted. Reserved for a user-initiated voice turn | Enters via user action (accepted speech, once a mic exists); 8-minute hold like `DECISION` |
| `DIGEST` | User-summoned; a producer-sealed, immutable, timestamped document | Paged; a page turn is a full refresh; not time-based |
| `GLANCE` | Default resting face; hash moves only on session state / milestone / count / integer usage change | No hold — this is what `8 min` holds *return to* |
| `ROSTER` | No daemon / no content | Static fallback; not the live dashboard |

None of these faces currently has a voice-specific trigger, because there is
no capture path to trigger from (§2: no mic, no speaker amp). The issue's
title question — the interface a *voice-capable* panel deserves — is
therefore still open on `trmnl_75` specifically, even though the surrounding
dashboard-face research it asked for as groundwork has already shipped.

## 5. Open decisions for the owner

Carried forward from the issue's own comment thread, restated against what
is now known:

- **PTT vs. wake word — blocked on hardware, and now more precisely so.**
  §2 confirms `trmnl_75` has no onboard microphone at all (Plus, not Sense),
  so *any* voice path on this exact board requires adding hardware — either
  swapping to a mic-carrying module or wiring an external PDM mic to the
  unpopulated I²S back-pads. That is a different, larger decision than
  "which button is PTT," which is what earlier issue comments answered for
  the *other* fleet boards (NM-EPD-420, LilyGo EPD47).
- **Does the dashboard/ROSTER face survive?** Answered by the shipped spec —
  yes, but demoted to a static no-content/no-daemon fallback, never the
  resting face. Restated here only because the original issue draft posed it
  as open.
- **Swift-daemon parity.** `/feed` and `/glance-frame` remain Node-daemon-only
  ([§ "Two of this issue's own preconditions..." comment](https://github.com/puritysb/AgentDeck/issues/272)).
  `trmnl_75`'s push path (raw `WsServer.broadcast()`, on-device rendering) is
  agent-neutral and already reaches a Swift-hosted daemon the same way it
  reaches Node — the parity gap is specifically the **pull** glance-frame
  path used by other boards, not this one. This is a scope decision the
  issue says has not been made, and this document does not make it either.
- **A proper repeat of the issue's own percentile measurement,** now
  possible cheaply because `repaintCount`/`fullRefreshCount` exist: sample
  the counter at the start and end of a defined 24h window (instead of
  replaying `apme.sqlite`) to get a rate comparable apples-to-apples with the
  issue's original 24h figures, and re-enable `--debug` for that same window
  so `broadcastActionability` (§1b) can report what fraction of the traffic
  reaching the board was actionable — the number this document could not
  produce retroactively.
- **Whether the per-push actionability line (§1b) should graduate into a
  `/health` counter** (a per-board aggregate, alongside `repaintCount`)
  rather than staying a `--debug`-gated log line, once there is a concrete
  consumer for it. Deferred here on purpose — the task this document answers
  asked for the smallest measurable step, not a wire-format change.
