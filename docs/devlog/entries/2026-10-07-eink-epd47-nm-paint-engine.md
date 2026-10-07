# 2026-10-07 — EPD47 and NM paint only what changed, say when, and stop holding WiFi on USB

### Problem

An audit of the two battery-capable e-ink panels against ten days of their own
`[EinkRefresh]` completion records (`~/.agentdeck/daemon-stderr.log`) found:

- **EPD47** erased and redrew every inked pixel on every content change — the
  retained frame went to `epd_draw_image(WHITE_ON_WHITE)` whole, then the new
  frame whole, across all 540 rows twice (1.32 s each, n=1420). 49% of its
  intervals sat exactly on the 60 s floor. 48 of 498 hard clears (2.04 s
  flashes) ran on a panel with nothing to clear: the ten-minute age rule fired
  on the first change after a quiet spell.
- **NM-EPD-420** (13.36 s full tri-color cycles, n=584) bypassed its 15-minute
  floor for half of its repaints and ran 14 back-to-back pairs — a second
  session started waiting during the first cycle and triggered another at once.
- **Both** were classified as pull surfaces with deep-sleep wake pins, but no
  firmware had a sleep path: they stayed awake and connected while the pull face
  set hid every DECISION until someone pressed a key.
- **Both** sat on WiFi and USB at once for a day (`wifiConnected=true,
  wifiRadioParked=false` while serial-primary). The daemon's legacy token
  re-arm sent `wifi_provision`; `wifiConnectWith()` restarted the radio and
  cleared the WiFi manager's parked flag, while the parking loop in `main.cpp`
  kept its own `static bool radioParked = true` and never parked again. The
  same loop body runs on every serial-capable board except IPS10 and TC001.
- Neither panel showed when its content was current. The contract's `as of
  HH:MM` band had no clock behind it: a serial-primary board never reaches NTP,
  and NTP is UTC.

### Fix

- `epd47_diff.h`: masked erase/draw images (old level where a pixel changed,
  new level where it changed, paper elsewhere) in a third PSRAM frame, driven
  only across bands of changed rows. Up to three bands, merged across gaps under
  96 rows from a driver cost model (a band costs ~185 ms of fixed phase overhead,
  a driven row ~2 ms). Measured on the desk unit after flashing: a small update
  takes ~400 ms instead of 1.31 s.
- `epd47_refresh_policy.h`: residue is charged per 30-row strip; a strip
  rewritten four times earns the hard clear, a clean panel never ages into one,
  and the post-touch sweep needs real residue.
- `nm_refresh_policy.h`: urgent transitions still bypass the ambient floor but
  wait 30 s after the previous cycle ended. The NM controller hibernates between
  cycles (no partial waveform, nothing to retain).
- Every e-ink panel skips a frame whose pixel writes hash identical to the frame
  on the glass (`FrameHash`, fed from `drawPixel` because GxEPD2 keeps its buffer
  private). The GLANCE content hash now includes a waiting session's question.
- `display_state.hostHm`: both daemons stamp host-local `HH:MM` on the re-sync
  they already send every 5 s (serial) / 15 s (WS). `util/host_clock.h`
  extrapolates between stamps; EPD47 and NM print `as of HH:MM`, or `since
  HH:MM` while offline, outside the content hash, and re-stamp an unchanged
  panel hourly (NM) / half-hourly (EPD47) while the host display is awake.
- Push delivery for every shipped e-ink board (`AGENTDECK_EINK_PULL_MODE` is
  the opt-in for a future board that sleeps). The NM decision face keeps all
  three options on the panel; the last one, usually Deny, used to fall off.
- EPD47 home: the right column lists every *other* session (glyph, name, state,
  question or durable milestone, overflow counted) and a tap opens that session.
  The first flash of this sheet repainted 1.45 s every minute with a hard clear
  every ~5 minutes: the primary was "the first working session", sessions flip
  working/idle every turn, and the sheet was sorted by state, so the whole left
  card and sheet swapped. The primary is now sticky (a newly waiting session
  still takes it at once; an idle one yields after three minutes) and the sheet
  keeps the daemon's order with waiting sessions first.
  Detail lines are durable milestones, never live tool text. Touch is sampled
  every 25 ms between paints instead of every 250 ms.
- `radio_park_policy.h`: the parking decision reads the radio's real state.
  NM and EPD47 boot parked and join WiFi only if serial stays silent for 10 s;
  a `wifi_provision` over serial is persisted for that join. `serialLoop()`
  marks the link alive before dispatching a line, so the first message after a
  boot or a serial lease is judged as serial.
- CLASSIC-font strings no longer carry a UTF-8 middle dot (rendered as
  garbage).

### Verification

Host tests (`esp32/sim/tests/eink_refresh_policy_test.cpp`: residue, masked
bands, NM gate, host clock, radio parking), all 12 firmware envs compile, NM and
EPD47 previews render, vitest/typecheck/build, the macOS app builds and its
`ESP32WifiForwardTests` pass. Both desk units were flashed over USB through
`agentdeck esp32 flash -f` (the first NM write failed at seq 43 and the retry
verified). After flashing both report `wifiRadioParked=true`,
`wifiConnected=false` while serial-primary, and kept their re-provisioned
credentials. The merged image rewrites NVS, so the daemon re-armed the token and
re-sent WiFi credentials, which the new firmware persisted without joining.

Twelve minutes after the final EPD47 flash: two boot paints (one hard clear),
then small updates at 399 ms with a 5.5-minute quiet gap, no further hard clear;
internal heap 100/78/37 KB free/min/largest (was 65/35/30 with WiFi up). NM:
five cycles in 27 minutes including boot and link-up, internal heap
120/106/63 KB (was 85/57, with one 3 KB largest-block reading).

NM's ~14.54 s cycles are not a regression: the old firmware ran the same length
in discrete clusters at certain hours (a different temperature-band LUT), next
to its usual 13.36 s.

Not verified here: the optical result on the glass (ghosting under masked
updates) and battery current. No board has a sleep path yet.
