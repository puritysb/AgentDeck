# Changelog

All delivery channels share one compatibility major. Minor and patch versions,
and prefixed release tags (`apple-v*`, `streamdeck-v*`, `ulanzi-v*`, `npm-v*`,
`android-v*`, `esp32-v*`), advance independently by target. Root `VERSION` is
the repository baseline, not a minor/patch ceiling: any numeric `A.B.C` and
`A.D.E` are mutually compatible. Minor releases add substantial backward-compatible
features; patches carry small backward-compatible fixes. `pnpm verify-version`
gates the shared major and target-internal version consistency. See
[RELEASING.md](RELEASING.md).

**This file is the source of every GitHub Release body.** `scripts/release-notes.mjs`
looks up a delivery tag here and renders the release page from what it finds;
`pnpm verify-release-version` refuses a tag with no entry. So a heading has to
name its channel: the channels no longer share a patch number — npm is at
1.0.21 while Apple is at 1.0.7 — and a bare `## 1.0.7` is ambiguous the moment a
second channel reaches it. Write `## <YYYY-MM-DD> — <Channel> <version>`, and
list every channel in the heading when one round is cut across several.

Entries below `## 2026-08-07 — npm 1.0.8` predate that rule and are kept as
written, under the shared numbering of the time. They are not looked up by tag.

### Known gaps

These versions shipped without an entry and are not reconstructed here, because
inventing a changelog after the fact states things nobody measured:
`npm 1.0.9`–`1.0.18`, `apple 1.0.4`–`1.0.6`, `android 1.0.5`–`1.0.8`,
`streamdeck 1.0.4`–`1.0.5`, `esp32 1.0.2`–`1.0.4`, `ulanzi 1.0.2`.
Their content is recoverable from the commit range between their tags.

One of them has no tag to recover it from. **`npm 1.0.14` is live on the
registry and was never tagged** — it was published from `8ee5a764` (the commit's
`bridge/package.json` reads `1.0.14`, and its timestamp matches the registry's
publish time to the second) and superseded by 1.0.15 six minutes later, so the
tag step never ran. It is left untagged deliberately: pushing `npm-v1.0.14` now
would fire the release workflow against a version npm already holds, and this
file's own rule forbids reconstructing its notes. The commit above is the
record. `npm 1.0.16` (`37c674b8`) is a different case and needs nothing — it was
bumped, superseded by 1.0.17, and never published, so it exists only in git.

## 2026-08-31 — npm 1.2.0

This is a backward-compatible minor release. It keeps protocol compatibility
major 1 and delivers the daemon, Surface, and Work-board changes accumulated
since npm 1.1.0. Managed agent launchers still work in this release. They are a
legacy compatibility path with no removal date, not a capability-removal notice.

### Normal agent commands are now the default launch path

`agentdeck claude`, `agentdeck codex`, `agentdeck opencode`, and
`agentdeck monitor` now identify themselves as legacy compatibility commands in
help and print an actionable notice before starting their existing per-session
bridge. The recommended default for ordinary local sessions is `agentdeck daemon
install` followed by the agent's normal command. `agentdeck diag agents [--json]`
checks the installed Claude Code,
Codex, and OpenCode versions against AgentDeck's lifecycle compatibility
baselines without opening a PTY or requiring a running daemon.

The old commands are not tombstones: remote attach, `--weight`,
`AGENTDECK_COMMANDER_ARGS`, agent-specific `AGENTDECK_*_ARGS`, terminal UI
steering, and terminal telemetry still have no daemon-first equivalent. The
managed implementation and `node-pty` remain available while replacements are
designed and validated in Discussion #278 and issue #273. A 1.1 managed worker's
register/state frames remain accepted by the 1.2 daemon and continue to surface
as managed sessions.

### Portable readers receive complete, bounded content

The daemon now distributes the licensed Pocket Daily Japanese N3 learning
pack and an automatic reader font pack, serves large assets in bounded resume
segments, and drives pull-aware paper faces for XTEink and InkDeck-class
readers. Surface mode and refresh counters make offline, sleeping, live, and
interactive states explicit instead of inferring them from whichever transport
last spoke. E-ink rotation, hardware refresh policy, and offline/connected
interaction states are aligned across the reader firmware and first-party
previews.

### Work-board tasks have stable names and useful boundaries

APME derives deterministic task titles and folded action lines from shared
rules, applies a measured idle-gap boundary, reaches both Node and native daemon
topologies, and exposes session drill-down data. The generated dashboard and
native mirrors replay the same vectors so a task is named and grouped the same
way on every surface.

### Codex limits and daemon shutdown are more reliable

Codex live-limit reconciliation now resolves the account/limit family before
accepting a passive reading, uses the weekly reset as an anchor with bounded
jitter, and refuses per-model pools that cannot vouch for the account reading.
This prevents an active rollout from replacing the real weekly account limit
with a differently scoped pool. Daemon push sockets also shut down safely while
still connecting, so test and process teardown no longer leaks an asynchronous
WebSocket error.

## 2026-08-27 — Apple 1.1.0

### The standalone Mac daemon now speaks the complete portable transport

The macOS app no longer needs a Node daemon for Surface Feed, offline Outbox
replay, pull telemetry, or resumable firmware delivery. Its native Swift daemon
validates the same product identity, stores staged firmware inside the App
Container, serves bounded resume segments, and clears an update only after the
reader reports the installed build.

Surface-aware WebSocket clients now negotiate the dashboard, companion,
portable-reader, or display-only profile. The Swift daemon enforces both the
events it sends and the commands it accepts against that negotiated capability
set; legacy clients keep their existing wire behavior.

Node remains the richer content author: adaptive Pocket cards and rendered
Glance Frame pixels are not copied into the App Store app. The Apple release
adds the transport/runtime needed for standalone operation without adding a
subprocess, companion executable, or external service.

## 2026-08-26 — npm 1.1.0

This is the first release under the compatibility-major version policy. It stays
on protocol-compatible major 1, but uses a minor bump because the delivery since
1.0.24 contains several substantial backward-compatible features rather than one
isolated fix.

### Surface Protocol, resumable OTA and offline weather

Surface Protocol v1 gives low-power and intermittently connected displays a
bounded Feed/Outbox contract instead of requiring a continuous WebSocket. Pocket
firmware downloads can resume with negotiated segments, discover an update before
a full feed transfer, survive dual-homed hosts through subnet-aware redirects,
and close a staged update after the installed version reports back. The same feed
now carries a cached weather outlook, and `/health` exposes build identity for
deployment diagnostics.

### OpenClaw activity is observable and actionable

The daemon now subscribes to the Gateway events that carry user messages, tool
calls and assistant metadata. APME receives real turn boundaries, provenance,
per-message usage and tool results instead of mostly empty 30-minute runs. Approval
prompts can be answered from AgentDeck, including sessions reached through relays,
without inventing duplicate activity when Gateway event paths overlap.

### Codex dashboards show the sessions and limits that are actually active

Codex Plus once again renders its 5-hour window alongside 7-day usage, while Pro
renders only the 7-day window it actually supplies. TUI and compact dashboard
layouts use `windowMinutes` rather than positional assumptions. Codex App chats
whose rollout files remain open but inactive leave the active roster after 90
seconds; project duplicates are folded consistently across consumers. A cached
serial endpoint also no longer suppresses fresher Wi-Fi display traffic.

### Device identity and routing are more reliable

Adopted boards report their configured identity, network discovery stops
advertising addresses devices cannot reach, and relayed Codex limits reconcile
against the authoritative snapshot before reaching dashboards.

## 2026-08-25 — Ulanzi 1.0.5

The plugin no longer ships a native binary on any platform. The Ulanzi Studio
team reported that macOS raises "Apple could not verify this file" on Apple
Silicon for `resvgjs.darwin-arm64.node`, the SVG rasterizer 1.0.4 bundled.

### Why a signature was never going to be the fix

A loose native module inside a folder Ulanzi Studio downloads and unpacks has
nobody who can sign it in a way Gatekeeper will accept for the process that
loads it: we do not build Studio, and Studio does not build our dependency.
`@resvg/resvg-js` also required one `.node` per architecture, so the single
Marketplace bundle had to carry five — 18.5 MB of a 20 MB plugin, four of which
any given user cannot run.

### One WASM file instead of five binaries

`@resvg/resvg-wasm` is the same resvg version (2.6.2) and the same Rust core,
pinned in lockstep with the native one it replaces, and it ships as one 2.4 MB
file that is identical on every OS and CPU. Measured against the 1.0.4 renderer
over 34 tiles spanning both raster sizes, every session state and every agent —
`feGaussianBlur` glow included — the output is **byte-identical**: same RGBA,
same PNG hash. This is not a renderer swap, and there is nothing left for
Gatekeeper or SmartScreen to adjudicate.

The cost is ~3.6–3.9× per uncached render (2.2 ms → 7.9 ms at 144 px, 3.1 ms →
12.0 ms at 196 px, plus 15.6 ms once at startup), which sits behind the existing
256-entry raster cache and well inside the Studio→device link's own budget.

Fonts were already explicit bundled faces with `loadSystemFonts: false`, so this
is a `fontFiles` → `fontBuffers` change and not a typography change. They are
load-bearing now in a way they were not before — the WASM build has no
filesystem and therefore no system-font fallback — so the packaging step refuses
to build a bundle missing them, and refuses one containing any `.node`, `.dylib`,
`.so` or `.dll` anywhere in the tree rather than trusting a list of package names.

The upload archive drops from 9.15 MB to 1.39 MB, and the installed plugin from
20 MB to 3.5 MB.

## 2026-08-24 — Ulanzi 1.0.4

1.0.3 went live on the Ulanzi Marketplace on or before 2026-08-24 — the first
AgentDeck build that store has ever published, seventeen days after it was
submitted. It was also, by then, seventeen days behind the repository. This is
the catch-up release, and the portal's rebuilt update flow is what makes it
cheap: a new version is now a *review version* that leaves the published one
serving downloads while it is checked, so there is no longer a reason to sit on
plugin work during a review.

### The D200X is claimed, once, and only for what it does

`Devices` now declares `D200H` and `D200X`. Both present the same 14 LCD keys to
Ulanzi Studio, and the layout engine is already sized off the keys the user
placed rather than off a device model, so the keypad needed no new code — only
an honest declaration. The D200X's three rotary encoders are deliberately NOT
claimed: they need their own action and their own UX, and a plugin that lists a
device it half-supports is worse than one that lists fewer devices. Requested in
[#174](https://github.com/puritysb/AgentDeck/issues/174).

### Three agents the published build could not draw

The store's 1.0.3 predates Kiro entirely and predates the OpenClaw approval work.
This build carries the current renderers, so Kiro CLI, Kiro IDE and Antigravity
sessions arrive with their own marks instead of falling through to a neutral
tile, and an OpenClaw permission prompt is both readable and answerable from the
key — 1.0.3 rendered its options as an inert mirror of a prompt nobody could
reach, because the live-answer path was gated on a session being *observed* and
the Gateway row is not.

### German, Spanish and Portuguese

The plugin shipped five languages while the Marketplace listing has always
required seven. `de_DE.json`, `es_ES.json` and `pt_PT.json` close that gap for
the palette entry, the setup panel and the H5 tutorial, in the SDK's own file
layout. Separately, `zh_HK.json` still described a D200H-only plugin after the
other four were updated — a locale left behind by a one-line edit, which is the
failure a per-file sweep exists to catch.

## 2026-08-23 — npm 1.0.24

1.0.23 shipped the flashers. A hardware run over the fleet then found two
defects in them, and both had the same shape: a write that fully succeeded
reported as a failure, or was refused before it started. Neither could be seen
from a green test suite, because both live in the wire between the host and a
board.

### The board now reboots into the firmware you just wrote

1.0.23's own notes called a real per-board reset open work. This closes it.

esptool-js's non-USB-OTG hard reset is, in full, `sleep(100); setRTS(false)` — a
*release* with no *assert*. That works only if whatever ran before left EN
asserted: `--before default-reset` does, and a finished `writeFlash` does not. So
every flash left the chip parked in the flasher stub. The firmware never ran, the
post-write `device_info` read-back could not succeed however long it waited, and
the CLI told users to power-cycle a board that had been written perfectly.

Both flashers now drive the reset themselves, from one sequence in the board
SSOT rather than one per flasher. Measured 2026-08-23 across three boards
spanning both of esptool-js's adapter strategies and the no-stub path:

| sequence            | T-Display-S3-Pro (native USB) | 86 Box (CH340) | TTGO T-Display (CH340) |
|---------------------|-------------------------------|----------------|------------------------|
| `after(hard_reset)` | parked                        | parked         | parked                 |
| `R1 W250 R0`        | booted                        | parked         | —                      |
| `D0 R1 W100 R0`     | booted                        | booted         | booted                 |

The `D0` is load-bearing and only the CH340 boards reveal it: pulsing EN without
first driving IO0 high leaves them in download mode, which from outside is
indistinguishable from a board that failed to boot.

### TTGO T-Display can actually be flashed

1.0.23 offered it in the browser picker. It could not be written there, or
anywhere: it was pinned `--no-stub`, the ROM loader has no compressed flash
mode, and the write died at `Failed to enter compressed flash mode` — before a
single byte landed. Making compression conditional moved the failure exactly one
step, to `Failed to enter Flash download mode`.

The evidence recorded for that board only ever claimed that it *connects*.
Connecting is not writing, and a board's verification now has to name a
completed write. With the stub it writes and boots end to end — 2.6 MB in 138
seconds, MD5 verified against the chip, and the board came up reporting its own
version. It also fixes the size guard as a side effect: stubless, this board's
flash id reads `0xffffff` and no size can be checked at all.

`esp32/platformio.ini` keeps its `--no-stub`, deliberately. That pin drives
`esptool.py`, a different tool, and changing it on evidence gathered from
esptool-js would be the guess this whole round exists to stop making.

### Still open

Stubless writing itself. Every `--no-stub` board measured so far fails before
writing a byte, and that is its own investigation. No board offered in the
browser is stubless now, so this affects only the CLI-only boards.

The browser flasher at [/flash/](https://puritysb.github.io/AgentDeck/flash/)
deploys from `master` and already carries both fixes; this release is the
terminal half.

## 2026-08-23 — ESP32 1.0.8

A small screen that runs out of room used to just stop drawing sessions. The
T-Display Pro said `+N more`, the general HUD had no bound at all, and InkDeck's
fixed grid simply ended — so a session waiting on your input could vanish behind
a full screen with nothing saying it had. Every ESP32 surface now shares one
glance order — **input → working → quiet context** — and states what it left
out: `4 idle hidden`, `hidden: 2 input / 3 working`. What is dropped is now a
fact on screen rather than an absence.

InkDeck applies the same order past its card capacity and prints the per-state
hidden counts in its header. The dense terrarium keeps the names of sessions
that are working or waiting and folds only the idle tags, so the creatures and
the summary roster split the job instead of competing for the same pixels.

### The IPS 10.1 office says state in more than one channel

The tiny `w` / `z` / `?` letter codes are gone. Idle is still and dimmed with no
badge at all, working is a cyan spark with a floor halo, awaiting input is an
amber `!`, error a coral `!`. Shape, motion and contrast now carry the state
redundantly with colour, so it survives distance and a washed-out panel. In a
narrow cell the session card gives the one-line name priority over the
decorative glyph — `OpenCode` and `Antigravity` no longer break mid-name.

### Two rendering defects

- **TC001's awaiting-input pulse went black.** The brightness curve ran through
  its negative half, so the one state that must never be missed disappeared for
  part of every cycle. Floored at 45%.
- **The new bounds allocate nothing.** Fixed arrays and stack buffers only —
  a render loop that allocates is how a no-PSRAM board OOMs under exactly the
  crowded scene these bounds exist to handle.

### Verified

Pixel-exact simulator scenes for IPS 10.1 dense and permission, Box dense,
T-Display Pro crowded Sessions, TC001 permission, and InkDeck dense — plus a new
10-session `dense` scene kept for future regressions. The e-ink layout
regression tests pass, as do the PlatformIO builds for `ips35`, `box_86`,
`led8x32`, `inkdeck`, `t_display_pro` and `ips10`.

## 2026-08-22 — npm 1.0.23 · ESP32 1.0.7

Firmware was building correctly for ten boards every release and piling up
somewhere nobody could reach it. All 31 assets of `esp32-v1.0.6` were downloaded
zero times, no page linked them, and the only documented way in assumed a source
checkout with PlatformIO installed. This release is the way in.

### Flash from a browser — nothing to install

[**puritysb.github.io/AgentDeck/flash/**](https://puritysb.github.io/AgentDeck/flash/)
writes firmware to a board over USB from desktop Chrome or Edge. Pick a board,
plug it in, done — no checkout, no toolchain, no `esptool.py`. Safari, Firefox
and mobile browsers do not implement Web Serial; the page checks that *before*
rendering the flow and hands you the terminal command instead, in English,
Korean or Japanese.

Five boards are offered — 86 Box, InkDeck, TTGO T-Display, Ulanzi TC001,
T-Display-S3-Pro — each because a hardware run measured it. The other five are
listed too, disabled, with the reason on screen: a board missing from the picker
reads as "unsupported" and sends its owner to the wrong page.

### `agentdeck esp32 flash <board>`

The same write from a terminal, with the two things a web page cannot do:

- **It frees the serial port itself.** Every serial open toggles DTR/RTS and
  resets the board, so a running daemon is the commonest cause of a failed
  flash. The CLI takes a lease the daemon honours — a *file*, because the daemon
  that steals the port is the one that respawns underneath the write, and an
  in-process pause cannot span a respawn. The lease expires when it is read, not
  on a timer, so a flasher killed mid-write needs nothing to run to recover.
- **It asks the board to introduce itself after the write.** MD5 against the
  chip proves the bytes; an image with a wrong flash-size header passes that and
  then bootloops, so the port is reopened and the firmware's own `device_info`
  is read back. Treat a reply as confirmation and its absence as no
  information: esptool-js's hard reset is a *release* with no *assert*
  (`reset.js` `HardReset` is `sleep(100); setRTS(false)`), so on an adapter that
  does not leave EN asserted after the write it is a no-op and the chip stays
  parked in the flasher stub. Measured on 86box, 2026-08-22: silent for 200s
  with exclusive port access after four separate writes, then up in 2.0s the
  moment `esptool --after hard-reset` pulsed EN for real — the firmware was
  correct the whole time. So the command reports "power-cycle it" rather than a
  warning, and a real per-board reset is still open work. `ulanzi_tc001` skips
  the read-back entirely by name — its CH340 TX is broken in hardware.

`serialport` is an optional native dependency; without it the command says which
two things to install and points at the browser flasher.

### The write is refused when the board is wrong

Both tools identify the chip before writing, and neither has an override. An S3
image on a classic ESP32, or a 16MB-header image on an 8MB part, is how these
boards get bricked — and the recovery tool for a bricked board is the tool that
refused. The size check is directional: declaring *less* flash than the part has
is fine, and on InkDeck it is required. An unreadable flash id stays unknown
rather than becoming `detectFlashSize()`'s silent "4MB", and the surface says the
check was unavailable instead of implying it passed.

### ESP32 1.0.7 — one file, one offset

A release now ships `agentdeck-<board>-merged.bin`, written at `0x0` on **every**
chip, plus a `manifest.json` whose sizes and hashes are computed from the
artifacts. The previous asset set could not bring a board up: `boot_app0.bin` was
never published, so a stale otadata boots the previous slot; the bootloader
offset is chip-specific and this fleet spans three values, documented nowhere;
and an unstated flash size leaves a wrong header. A board that fails to build now
fails the release instead of shipping nothing quietly — the failure that left
three boards with no binaries at all in 1.0.1.

## 2026-08-22 — npm 1.0.22 · Apple 1.0.8

Codex usage was reporting the wrong number in two independent ways. Both are
producer-side, so every surface — dashboard, menubar, Stream Deck, D200H,
e-ink, ESP32 — is fixed by updating the daemon; no plugin reinstall or firmware
reflash is involved.

### Codex usage reported the wrong quantity, then no quantity at all

- **A per-model limit was published as the account's.** Codex writes several
  rate-limit *families* and each rollout line carries whichever one that request
  was metered against — `codex` and `premium` meter the account, while
  `codex_bengalfox` ("GPT-5.3-Codex-Spark") meters one model. Within a single
  session the family alternates hour to hour, and the readers took the newest
  line regardless, so the gauge showed Spark's 5h 0% / 7d 0% while the account
  sat at 13%. A named limit is now recognised as a scoped one and skipped; the
  readers keep scanning to the account-wide line behind it, and the live
  `codex app-server` query falls back to the unnamed family. When only scoped
  lines exist nothing is reported rather than 0% under the wrong label.
- **A plan change blanked every Codex gauge.** A snapshot stamped with a plan
  the account no longer holds is void, not merely old — but that check ran
  *after* the snapshot was chosen, so the one snapshot guaranteed to be
  discarded won on recency every time, while a valid one sat unread on disk.
  Plan agreement is now the primary ranking key and age only the tie-break, and
  a mismatch no longer lets a "fresh" rollout suppress the live query that
  carries the only usable number. Upgrading or downgrading a ChatGPT plan is the
  case this covers.
- `prolite` (ChatGPT Pro Lite) is named correctly instead of falling back to
  "ChatGPT Prolite", and the tier table is now generated for Swift and Kotlin
  from one source so the same account cannot read differently per surface.

### Also in npm 1.0.22

- Python BLE workers the OS kills for a revoked Bluetooth grant no longer
  respawn forever: three consecutive SIGABRT exits halt the loop and name the
  fix. A Rosetta (x86_64-only) interpreter is refused by reading the Mach-O
  header rather than by importing `bleak`, and such a venv is removed and
  rebuilt rather than reused.
- A failed usage fetch no longer launders itself as a fresh one, and a file
  cache whose TTL is an exact multiple of the poll interval no longer costs a
  whole extra interval.
- Firmware staged for a board that never pulls its feed is reported as staged
  rather than as delivered.

### Also in Apple 1.0.8

- The three daemon topologies (no daemon / in-process Swift / external Node
  with this app as its client) are a single state with explicit transitions, so
  a teardown while in client mode no longer clears the Claude quota, Codex rate
  limits and subscription rows — which is what editing any setting while
  attached to a Node daemon used to do.
- A relayed usage reading with no producer timestamp is treated as
  unknown-age instead of being restamped as just-fetched.
- Kiro's brand colours reached the design tokens, and its documentation caught
  up with the code that already observed it.

## 2026-08-19 — ESP32 1.0.6

One fix, and it is worth saying how it was found.

- The IPS 10.1" card header called a Kiro session `Agent`, while the office desk
  beside it — on the same screen, for the same session — said `Kiro`.
  `ui/agent_label.h` is the one place the firmware turns an agentType into a
  brand name and names this exact surface as its consumer, but `hud_bar.cpp`
  included it and then declared a private copy of the same map, written before
  Kiro existed. The local map is now a call to `agentShortLabel`: every other
  agent keeps its exact label, and an unknown agentType falls to its raw id
  rather than to `Agent`
  ([#235](https://github.com/puritysb/AgentDeck/pull/235)).

No compiler or test could have caught this. A label map with a `default` is
total — every input returns something — so what was missing was a distinction,
not a case. It was found by rendering the screen in `esp32/sim`, which compiles
these sources verbatim at each board's real resolution, and looking at it. That
also discharges the caveat 1.0.5 shipped with ("this is code that compiles, not
a screen that was looked at"): the boards were serial-attached and unflashable,
but the simulator never needed them.

**Only `ips_10` changes.** The edit sits behind
`BOARD_IPS10 && BOARD_HAS_VOICE_CAPTURE`, so every other board's image differs
from 1.0.5 by the version string alone. Firmware for all ten boards is published
here regardless, since a release set that skips boards is how three of them
ended up with no downloadable firmware at 1.0.1.

## 2026-08-18 — npm 1.0.21 · Apple 1.0.7 · Android 1.0.10 · Stream Deck 1.0.6 · ESP32 1.0.5

One round, cut across five channels from the same commit, so the entries are
grouped by what they change rather than by which artifact carries them.

### Kiro observation

- Observe Kiro sessions without being asked to manage them. Users run native
  `kiro-cli` or the Kiro IDE as usual and the daemon correlates the process with
  Kiro's own stores — the v2 app-data SQLite, or the v3 `sessions/` JSON plus
  `messages.jsonl` — read through a query-only handle that never touches auth or
  telemetry tables ([#198](https://github.com/puritysb/AgentDeck/pull/198),
  [#202](https://github.com/puritysb/AgentDeck/pull/202))
- Fill the Kiro timeline from Kiro's own transcript, because nothing else ever
  will. Kiro's global standalone hooks load and then fire for no CLI chat turn
  at all (measured on kiro-cli 2.18.1: a live turn produced zero hook markers
  while a hand-POSTed hook produced a timeline row normally), so both daemons
  poll the transcript instead. Two consequences are by design: a Kiro session
  appears seconds late rather than instantly, and it always reads `idle` —
  a transcript gains its assistant record only once the reply has landed, and
  claiming `processing` would be inventing a state
  ([#218](https://github.com/puritysb/AgentDeck/pull/218))
- Draw Kiro as Kiro, or as nothing — never as Claude. The surfaces that bucketed
  agents with a deny-list dressed every agent they predated as the bucket's
  owner, so Kiro sessions swam as Claude octopuses and took Claude's glyph and
  OpenCode's palette. Those buckets are allow-lists now, pinned by tests on the
  polarity rather than on the membership, so a future agent renders as neutral
  instead of as somebody else
  ([#216](https://github.com/puritysb/AgentDeck/pull/216))
- Give Kiro its name, mark, colour and terrarium creature across the dashboard,
  the decks and the ESP32 boards
  ([#205](https://github.com/puritysb/AgentDeck/pull/205),
  [#206](https://github.com/puritysb/AgentDeck/pull/206),
  [#217](https://github.com/puritysb/AgentDeck/pull/217))
- Capture Kiro's spoken reply instead of its redacted `Reasoning` placeholder,
  and keep the subject in a tool label rather than just the tool name
  ([#200](https://github.com/puritysb/AgentDeck/pull/200),
  [#204](https://github.com/puritysb/AgentDeck/pull/204))
- Count one Kiro chat as one session, tell an unreadable transcript apart from
  one nobody has typed into, and read the store from the sandboxed macOS app too
  — through a user-granted directory bookmark in Settings → Integrations, so
  with no grant it observes nothing rather than guessing
  ([#202](https://github.com/puritysb/AgentDeck/pull/202),
  [#207](https://github.com/puritysb/AgentDeck/pull/207),
  [#220](https://github.com/puritysb/AgentDeck/pull/220))
- Add `agentdeck diag kiro [--json]`, a daemon-free probe that is safe to paste
  into an issue: content-free, with report-scoped opaque keys for cwd and
  session identity ([#198](https://github.com/puritysb/AgentDeck/pull/198))

### Sessions, turns and subagents

- Count subagents at the hook and report them as `SessionInfo.subagents`
  (`active` / `peak` / `completed`). A parent whose turn closed is genuinely
  idle while its children work, so this is a second axis beside `state`, not a
  correction to it. Deriving it from timeline rows read near zero in exactly the
  fan-outs it describes — siblings of one workflow emit byte-identical rows in
  the same millisecond and were deduped to one, and eviction shed the dispatch
  row first. Measured on a real workflow session: 72 completions, peak 8
  concurrent, and zero surviving dispatch rows
  ([#219](https://github.com/puritysb/AgentDeck/pull/219))
- Say which company answered, without calling it a different agent. A Claude
  Code session pointed at another provider's endpoint is still Claude Code —
  same binary, hooks and transcript — so it keeps its `agentType`, and the fact
  that its weights came from somewhere else rides a separate signal that is set
  only when both sides are known and disagree
  ([#219](https://github.com/puritysb/AgentDeck/pull/219))
- Recover turns whose Stop hook never arrived, in observed sessions as well as
  managed ones — the previous release wired the watchdog only to PTY bridges,
  which covered none of the real traffic. Recovery re-enters the real Stop path
  rather than reimplementing it
  ([#194](https://github.com/puritysb/AgentDeck/pull/194))
- Tell a turn that never owed a Stop apart from one that lost it. A user cancel
  emits no hook at all, so counting it as a dropped Stop inflated the loss
  ratio with events that were never due; ESC cancels are now their own bucket
  and stay out of that ratio, detected both while the marker is still the
  transcript tail and on the commoner cancel-then-retype shape
  ([#195](https://github.com/puritysb/AgentDeck/pull/195),
  [#213](https://github.com/puritysb/AgentDeck/pull/213))

### Daemon

- Ask which user owns a daemon before adopting its token or shutting it down. On
  a shared host every same-machine privilege reached every account on the box:
  starting a CLI daemon shut down every colleague's macOS app, and a port scan
  registered one user's sessions with whoever answered first. Ownership is now a
  three-valued question answered at the point a peer is discovered; unproven
  ownership stays permissive, because refusing there is what breaks a whole
  paired fleet's authentication ([#215](https://github.com/puritysb/AgentDeck/pull/215))
- Give the CLI daemon a preferred port and make it wait for that port. A daemon
  bumped to a fallback had no record of the port it wanted, so a 14-second
  kernel hold on 9120 became permanent until someone restarted it by hand. The
  intent is persisted and only the user writes it (`agentdeck daemon port <n>`);
  the outcome never is, since recording the fallback would make it preferred
  forever after ([#212](https://github.com/puritysb/AgentDeck/pull/212))
- Make the daemon port window overridable, so a throwaway daemon can exist
  alongside the real one ([#211](https://github.com/puritysb/AgentDeck/pull/211))
- Surface the network posture in the macOS app as Settings toggles, matching the
  CLI's two axes, and tighten loopback mode's ADB reverse to USB transports
  only — a cable-carried tunnel terminates on the host's own loopback, but a
  wireless-debugging transport would carry it over the LAN
  ([#203](https://github.com/puritysb/AgentDeck/pull/203))
- Generate the Swift daemon's state-transition table from the shared TypeScript
  source. A row present in one daemon and absent in the other is a session that
  wedges on one platform and recovers on the other, with nothing in either log
  saying why ([#196](https://github.com/puritysb/AgentDeck/pull/196))

### OpenClaw

- Make an OpenClaw approval something the user can read and answer, rather than
  a prompt that renders without its question
  ([#214](https://github.com/puritysb/AgentDeck/pull/214))
- Say why an OpenClaw turn failed, and let the failed turn close its task
  instead of leaving it open — an open task is never judged
  ([#209](https://github.com/puritysb/AgentDeck/pull/209))

### macOS app — Apple 1.0.7

- Hide the Dock icon while no AgentDeck window is open, so a menu-bar-only user
  gets a menu-bar-only app. The rule is an allow-list of scene ids rather than a
  window count: `NSApp.windows` also holds the menu-bar panel and AppKit
  internals, so a count never reaches zero and the rule silently never fires
  ([#222](https://github.com/puritysb/AgentDeck/pull/222))

### Stream Deck plugin — 1.0.6

- Show up to four usage keys on 15-key and larger devices (Claude 5h and 7d,
  Fable, Codex 7d) instead of stopping at the first two
  ([#225](https://github.com/puritysb/AgentDeck/pull/225))

### Devices — ESP32 1.0.5

- Carry Kiro's colour, glyph and creature onto the boards
  ([#217](https://github.com/puritysb/AgentDeck/pull/217))
- Clamp Pixoo creatures above the active Usage HUD rows, so idle sprites stay
  visible instead of being drawn under the gauges
  ([#225](https://github.com/puritysb/AgentDeck/pull/225))

## 2026-08-15 — Android 1.0.9

### Android dashboard

- State the computer prerequisite on every disconnected screen, including the
  high-contrast e-ink layout: open AgentDeck Dashboard on a Mac or run
  `npx @agentdeck/setup` on macOS, Windows, or Linux
- Publish the unified first-connection path from 1.0.8 to Google Play: prefer
  USB when present, discover a daemon over Wi-Fi, allow code-based pairing on
  camera-less readers, and stop retry storms after an unpaired device is
  rejected
- Keep the 1.0.8 e-ink usage-limit clipping fix in the Play release

## 2026-08-14 — npm 1.0.20

### CLI and daemon — npm

Fixes two regressions that shipped in 1.0.19 when the terminal parser stopped
driving lifecycle state, plus follow-up hardening. 1.0.19 removed the parser
exit signals from the AWAITING states without adding hook-based replacements,
and removed the Claude missed-Stop recovery without a substitute — the second
of these was not called out in the 1.0.19 notes.

- Close a managed session's permission/option/diff prompt state when the user
  answers at the keyboard. 1.0.19 left such sessions wedged in "awaiting"
  forever (with the stale question still answerable from devices); prompts now
  exit on the turn's tool-activity hooks, on Stop, and on the next prompt
  submit. Guards keep a live prompt safe: a short grace after the prompt is
  drawn, a parallel sibling finishing never dismisses while the gated tool is
  still pending, a straggler tool-end after Stop never reopens a finished
  session, and the daemon hub's multiplexed state machine opts out of
  tool-activity recovery entirely
- Recover Claude turns whose Stop hook never arrives: a watchdog probes the
  transcript JSONL tail (never the screen) once the hook channel goes quiet
  and closes state, timeline, and the APME turn through a synthetic Stop. A
  genuine open prompt (`stop_reason: "tool_use"`) is never force-closed
- Recover a dropped `UserPromptSubmit`: tool-activity hooks arriving while
  IDLE now move the session to processing
- Warn once, on the timeline and in the session log, when a managed Codex
  session's terminal is active but no lifecycle hook or notify event ever
  arrives — hooks and notify share one curl/port path, so a stale port kills
  both silently
- Map only an explicit `error` key on `codex_stop` to an error row. A bare
  `message` is no longer treated as an error (it carries content on every
  other Codex event; neither key appears in any of 311 recorded real Stop
  payloads)
- Read the Codex lifecycle baseline from the package's `compatibleCodex`
  field instead of a hardcoded literal, and align the remaining
  architecture docs (protocol, APME pipeline) with the hook-primary design

## 2026-08-13 — npm 1.0.19

### CLI and daemon — npm

- Make lifecycle hooks and structured agent events the authority for session
  state, timelines, and APME turns. Terminal parsing is now limited to UI-only
  affordances that hooks do not expose, such as permission choices, model and
  project labels, cursor position, and Claude's mode and diff display
- Recover Claude responses from the Stop-hook transcript and Codex responses
  from lifecycle notifications plus rollout JSONL, removing the spinner and
  terminal-ring-buffer fallbacks without losing supported-path conversation
  capture
- Refresh Claude, Codex, and OpenCode integrations from
  `agentdeck daemon install`, so users can run `claude`, `codex`, and
  `opencode` directly. Managed `agentdeck <agent>` terminals remain optional
- Keep the AgentDeck 1.0 wire protocol unchanged. The supported lifecycle
  baselines are Claude Code 2.1.50 or newer and Codex CLI 0.141.0 or newer;
  explicitly disabling Codex hooks leaves managed terminal UI observation but
  not lifecycle timelines

## 2026-08-10 — Ulanzi 1.0.3

Backfilled after the fact from the `ulanzi-v1.0.2..ulanzi-v1.0.3` commit range,
so it lists only changes that provably touched `plugin-ulanzi/`.

- Ship the setup tutorial the Ulanzi review asked for, built on their SDK's own
  rails rather than a hand-rolled panel, with `en` / `ko_KR` / `ja_JP` copy
  ([#157](https://github.com/puritysb/AgentDeck/pull/157))
- Let the D200H animate, and give every key its own phase. Motion is baked into
  a looping GIF — Ulanzi Studio plays and loops it on the device, so a
  transition costs one push and steady-state motion costs nothing — which means
  every animated value has to return to its start on the same frame or the tile
  jumps once per loop. The phase rotation has one definition, because deriving
  it separately for "collect the frames" and "is this tile still current?" made
  every phase-shifted key read as permanently stale, so its encode was cancelled
  and requeued forever and the only symptom was that nothing animated
- Make the D200H voice key actually work — two bugs, both measured
  ([#158](https://github.com/puritysb/AgentDeck/pull/158))
- Measure what the D200H push path actually admits, and keep the plugin inside
  it rather than guessing at the limit

## 2026-08-07 — npm 1.0.8

### Setup — npm

- Let `npx @agentdeck/setup` finish on a machine with no coding-agent CLI.
  The installer refused to complete unless `claude` or `codex` was already on
  PATH — exactly the state of a computer that only has the Claude or ChatGPT
  desktop app installed, which is how the Ulanzi review team first met it.
  The CLIs were never a real prerequisite: the daemon and every device surface
  install and run without one, and sessions appear as soon as an agent does.
  The check now warns and points at the install commands instead of failing

## 2026-08-06 — 1.0.7

### Answering an agent's question from a device

- Answer AskUserQuestion from a device even when AgentDeck cannot reach the
  terminal. Until now the only working channel was typing into the session's
  own terminal, which needs subprocesses the sandboxed macOS daemon does not
  have — so on the App Store app every tap on a question was logged and
  dropped. Both daemons now hold the question's PreToolUse hook open and
  resolve it with the option the user picked, stated as the decision reason
  (the same channel STOP and the turn-end queue already use). It only engages
  when typing is unavailable, so nobody sitting at a reachable terminal waits
  for anything; an unanswered hold releases empty and Claude's own picker
  appears exactly as before — nothing ever proceeds on the user's behalf
- Ask each question of a multi-question prompt in turn. One AskUserQuestion
  call can carry up to four questions; only the first ever reached a device,
  and answering it left the old options on screen while the agent had moved on
  — so the next tap sent an index into a different list and silently picked the
  wrong answer. Questions are now presented one at a time and advance as each
  is answered, and a press carries the question it was answering so a late tap
  is dropped instead of misapplied
- Stop the deck from missing the follow-up question. The D200H compared two
  questions as identical (its repaint signature ignored per-session questions
  and options), opening a session blanked its live prompt with the daemon's
  global state, and both decks carried the previous question's page number into
  the new one
- Show the answer buttons as answerable in the Mac, iPhone/iPad and Android
  apps. They decided that from `controlMode` alone, so they refused sessions
  the daemon could answer and would have refused every held question too
- Select the option the user actually pressed. Typing an answer into a
  session's terminal sent the arrow keys and the Return that acts on them in
  one burst, and the picker resolved the Return against the cursor position
  from *before* the arrows — so every device answer silently chose the first
  option. Pressing "Blue" selected "Red". The keys are now paced apart, the
  way the dictated-prompt path already did it
- Require an answer to name the question it answers. Several surfaces map a
  hardware "approve" key to option 0 as a stand-in for a yes/no gate (ESP32
  mosaic, NFC approve tags). Against a permission gate that means something;
  against a four-way question it is a guess, and this path would have submitted
  it as the user's stated answer. A surface that renders the real choices can
  say which one it is answering; a binary approve key cannot, and is now
  refused rather than guessed at
- Hold a question only when some device can actually see it. The hold was keyed
  off "cannot type into this terminal", which is also true of a session the
  observer has not scanned yet — so the one case that stalled a terminal for
  the full hold was the case where nobody could answer
- Submit a grouped question instead of stranding it. A multi-question
  AskUserQuestion does not close when its last question is answered; it shows a
  "Review your answers → Submit answers" confirmation, which nobody was at the
  terminal to press, so the agent waited on a form the user could not see. The
  count that decides this is what Claude rendered, not what AgentDeck managed to
  parse — a question group dropped as malformed is still a tab in the user's
  form

### CLI and daemon — npm

- Archive the reply half of every conversation. `turns.response` was NULL for
  every recent hook-observed turn — the timeline showed the text while APME
  stored none of it, so the dashboard could not replay a conversation and the
  judge scored turns against silence. Both daemons now record the response on
  the branch that already has it
  ([#135](https://github.com/puritysb/AgentDeck/pull/135))
- Close runs abandoned by a daemon restart. Their tasks never closed, so they
  were never judged — 65 open tasks against 9 closed — and the existing orphan
  reaper only matched empty shells. The sweep also stopped stalling the daemon:
  covering indexes take it from 22s to 7ms on the real store
  ([#135](https://github.com/puritysb/AgentDeck/pull/135))
- Query Codex for the quota it can no longer write down. The rollout
  `rate_limits` block is a byproduct of a *successful* turn, so a passive read
  freezes one turn short of the wall and never sees usage spent on Codex Cloud
  or another machine; a throttled `codex app-server` query now backs it, and the
  fresher `capturedAt` wins ([#131](https://github.com/puritysb/AgentDeck/pull/131))
- Report whether the BLE panels are actually connected. Timebox Mini and
  iDotMatrix are driven by spawned Python clients that reconnect inside their
  own loop, so process liveness said nothing about the link and a powered-off
  panel still read as streaming; the clients now emit one status line per state
  change ([#132](https://github.com/puritysb/AgentDeck/pull/132))
- Start the Node summarizer on-device, matching the Swift daemon: the chain is
  now Foundation Models → MLX → Ollama → heuristic, so the same response no
  longer summarizes differently depending on which daemon happens to be up
- Stop offering embedding-only models as judge candidates — an embedder passed
  the setup screen and failed on the first real judge call
- Price local models correctly: `foundationModels:apple-intelligence` and
  `mlx-community/...` fell through to UNKNOWN_PRICE, which reads as *unpriced*
  rather than free, and grouped under provider `unknown` instead of `local`
- Trim `config/default-settings.json` to the keys a loader actually reads, with
  a drift gate — six of its seven top-level keys had no reader at all, and with
  no consumer nothing caught it claiming `judge.backend: mlx` while the code
  defaults to Foundation Models

## 2026-08-05 — npm 1.0.6

### CLI and daemon — npm

- Repair host push-to-talk end to end: the deck's hold-to-talk path now reaches
  the daemon's capture, transcription and reply legs as one working chain
  rather than a set of individually plausible halves, and a spoken reply is
  digested through one shared formatter
  ([#124](https://github.com/puritysb/AgentDeck/pull/124))
- Stop the Gateway model name from claiming rows that belong to other sessions
  ([#124](https://github.com/puritysb/AgentDeck/pull/124))

`1.0.5` shipped push-to-talk as a feature while that chain was still broken;
this is the patch that makes it work, so prefer it over `1.0.5`.

## 2026-08-05 — 1.0.5

### Android dashboard

- Target Android 16 (API 36). Google Play stops accepting uploads below API 36
  on 2026-08-31, and the app was still on 34 — under even the API 35 floor in
  force since 2025-08-31, so a bundle would have been rejected at upload rather
  than at review. The toolchain moved with it: AGP 8.13.2, Kotlin 2.3.21,
  Gradle 8.14.5, Compose BOM 2026.03.01
  ([#146](https://github.com/puritysb/AgentDeck/pull/146))
- Stop the two HUD rails from drawing through each other on phones. Tablets
  sized them against the screen; phones took a bare maximum width, so a 220dp
  session list and a 300dp topology rail overlapped by ~109dp on a 411dp
  display and the dashboard read as two interleaved columns of text
  ([#146](https://github.com/puritysb/AgentDeck/pull/146))
- Make the attention card opaque where it lands on those rails. At a 65% fill
  it was depth on a tablet and unreadable on a phone, with session names and
  quota figures showing through the agent's own question
  ([#146](https://github.com/puritysb/AgentDeck/pull/146))


### CLI and daemon — npm

- Validate the daemon port before a hook constructs a loopback URL, so a
  malformed or hostile port value cannot steer the request
  ([#105](https://github.com/puritysb/AgentDeck/pull/105))
- Discover iDotMatrix-protocol panels by advertised service UUID and known name
  families rather than the `IDM-` vendor prefix, so a rebranded but
  protocol-identical display (iPixel) is found by a scan instead of needing a
  hand-written address; `idotmatrixNamePrefixes` in `settings.json` widens the
  name fallback without a release
  ([#115](https://github.com/puritysb/AgentDeck/issues/115))
- Surface Claude per-model scoped usage limits, and date the Codex snapshot so a
  frozen percentage can no longer read as live
  ([#99](https://github.com/puritysb/AgentDeck/pull/99),
  [#121](https://github.com/puritysb/AgentDeck/pull/121))
- Resolve Claude usage OAuth credentials on Windows and Linux instead of only
  macOS ([#98](https://github.com/puritysb/AgentDeck/pull/98))
- Observe Codex Desktop sessions through OpenTelemetry and lifecycle hooks, and
  discover top-level Desktop rollouts without blocking scans
  ([#109](https://github.com/puritysb/AgentDeck/pull/109),
  [#111](https://github.com/puritysb/AgentDeck/pull/111))
- Track the interactive-prompt lifecycle through concurrent spinner redraws, so
  a queued prompt no longer leaves a session stuck awaiting
  ([#108](https://github.com/puritysb/AgentDeck/pull/108))
- Add an adaptive offline card feed with calendar events and an offline-reader
  projection, plus daemon-rendered glance frames for pull clients
  ([#110](https://github.com/puritysb/AgentDeck/pull/110),
  [#112](https://github.com/puritysb/AgentDeck/pull/112))
- Carry host push-to-talk from the deck through the daemon's voice ingest and
  egress path, including device audio replies
- Add `--weight` as an explicit deck/tab sort override, and
  `AGENTDECK_COMMANDER_ARGS` / `AGENTDECK_<AGENT>_ARGS` as env-var default
  session arguments ([#62](https://github.com/puritysb/AgentDeck/pull/62),
  [#93](https://github.com/puritysb/AgentDeck/pull/93))
- Add opt-in cross-machine session attach over the existing daemon socket
  ([#53](https://github.com/puritysb/AgentDeck/pull/53)) and a Linux systemd
  `--user` daemon unit ([#54](https://github.com/puritysb/AgentDeck/pull/54))
- Stage ESP32 firmware for pull OTA
  ([#113](https://github.com/puritysb/AgentDeck/pull/113))
- Show subagent work as activity rather than as separate sessions

## 2026-07-30 — 1.0.4

### Stream Deck plugin

- First-class Stream Deck XL (32 keys) and Stream Deck + XL (36 keys, 6 dials)
  support, with importable bundled profiles per device model
  ([#94](https://github.com/puritysb/AgentDeck/issues/94),
  [#97](https://github.com/puritysb/AgentDeck/pull/97))
- Windows joins macOS through a cross-platform system layer: media-key volume,
  Start-menu app launch, and browser fallbacks
  ([#96](https://github.com/puritysb/AgentDeck/pull/96))
- Adapt the Codex usage encoder to a single live window, and keep a session's
  detail from wearing the previous session's model
  ([#100](https://github.com/puritysb/AgentDeck/pull/100),
  [#124](https://github.com/puritysb/AgentDeck/pull/124))
- Wire the hold-to-talk VOICE key to the host's microphone

### Android dashboard

- Propagate live panel profile changes to the monitor service and daemon
  registration, and harden the e-ink DeviceProfile evidence so a reader is not
  misclassified ([#106](https://github.com/puritysb/AgentDeck/pull/106),
  [#107](https://github.com/puritysb/AgentDeck/pull/107))
- Surface Claude per-model scoped usage limits, and date the Codex snapshot so
  a frozen percentage cannot read as live
  ([#99](https://github.com/puritysb/AgentDeck/pull/99),
  [#121](https://github.com/puritysb/AgentDeck/pull/121))
- Unify device classification into a DeviceProfile SSOT
  ([#89](https://github.com/puritysb/AgentDeck/pull/89))
- Honour the `--weight` session sort override
  ([#62](https://github.com/puritysb/AgentDeck/pull/62))

### CLI and daemon

- Ship the iDotMatrix and Timebox Mini Python BLE clients in
  `@agentdeck/bridge` instead of resolving files that only exist in a source
  checkout
- Prepare optional BLE dependencies lazily under
  `~/.agentdeck/python-ble`, preserving npm installs as PyPI-free and keeping
  the environment across global package upgrades
- Report missing or unprepared BLE support with `agentdeck ble status` /
  `agentdeck ble setup` guidance instead of crashing on a missing Python
  executable or silently disabling daemon sync

## 2026-07-29 — 1.0.3

### macOS and iPhone/iPad — App Store

- Bound the iOS connection indicator and add an explicit no-Mac path, so a
  persistent Bonjour browse can no longer render as an endless "Searching for
  AgentDeck…" ([#114](https://github.com/puritysb/AgentDeck/pull/114)) — the
  correction for the 2026-08-04 Guideline 2.1(a) rejection of iPhone/iPad 1.0.2
- Discover iDotMatrix-protocol pixel panels by their advertised service UUID
  and known name families instead of the `IDM-` vendor prefix, so a rebranded
  but protocol-identical display (iPixel) appears in Scan
  ([#115](https://github.com/puritysb/AgentDeck/issues/115))
- Repair host push-to-talk in the in-process daemon: capture, transcription and
  the spoken reply form one working chain, stale capture files are swept, and
  the Gateway model name no longer claims rows belonging to other sessions
  ([#124](https://github.com/puritysb/AgentDeck/pull/124)). Delivery to an
  *observed* session remains the queued-directive ladder — a prompt dictated to
  an idle session waits for that session's next turn end
  ([feature matrix](docs/appstore-feature-matrix.md))
- Date the Codex usage snapshot so a frozen percentage cannot read as live
  ([#121](https://github.com/puritysb/AgentDeck/pull/121))

### Stream Deck plugin

- Restore Windows Marketplace installation instead of disabling an existing
  locally linked plugin when the macOS-only store manifest is applied
- Make Volume functional on Windows through built-in media keys and make
  Launcher/offline help open Start-menu apps or browser fallbacks, while
  preserving richer macOS volume readback and existing-tab focus

### CLI and daemon

- Stop the Node Bonjour publisher from claiming the Mac's own `.local` hostname
  and triggering macOS collision handling that renamed the computer on every
  daemon start
- Use a process-scoped service host that remains stable across sleep/wake and
  network recovery re-publication without mutating the system LocalHostName

### Android dashboard

- Preserve observed AskUserQuestion activity so attention prompts remain visible
  instead of being folded into low-signal tool noise
- Show Claude and Codex subagent work as decorative orbiting activity around the
  parent creature without creating extra sessions or control targets
- Pair subagent start/completion rows per parent session and expire orphaned
  activity so stale satellites do not remain on the dashboard

## 2026-07-22 — 1.0.2

### Ulanzi plugin — D200H

- Add a Property Inspector to the action. Ulanzi's review reported that dragging
  the action onto a key left testers with no instructions: the action declared no
  `PropertyInspectorPath`, so Ulanzi Studio showed its own "Setup / Click for
  guide" placeholder with nothing behind it. Clicking now opens getting-started
  steps for both daemons and a live check that says whether one is reachable
- Packaging refuses to build an archive whose manifest names a Property
  Inspector the package does not contain

### ESP32 firmware

- Ship firmware for **every board marked Shipping** — T-Embed CC1101,
  T-Display-S3-Pro and the Waveshare C6-LCD-1.47 had no downloadable binary in
  `1.0.1` because the release matrix listed seven boards while ten were
  supported
- Name each asset by the board's canonical id (`agentdeck-ips_10.bin`), the same
  string `agentdeck esp32-ota <target>` takes, so a downloaded file is directly
  the update target; add `SHA256SUMS.txt` and the Wi-Fi OTA instructions
- Restore linking on the ESP32-classic boards: the per-session option list had
  grown `g_state` past TTGO's DRAM segment, so TTGO and TC001 now cap that array
  at two entries — neither surface can render an option list
- Voice: push-to-talk on the IPS10 touch panel and the T-Embed encoder, with the
  reply spoken back through the board's own speaker where one exists
- Restore JC8012P4A1C touch: the vendor-derived clear sequence wrote `0x88`,
  while `0x80` is the Silead touch-count register that actually starts the
  panel's scan core
- InkDeck and XTeink glance rendering, camera show-and-tell on the Focus Strip,
  and a Pocket phone-style UI for the camera strip

### Daemon and timeline

- Keep the Node daemon discovery registry healthy while the process is running,
  restoring a missing, malformed, or stale `daemon.json` every ten seconds
- Preserve hook timeline ingestion when the daemon binds a fallback port instead
  of silently sending Claude Code and Codex lifecycle events to an empty port
- Avoid overwriting another live daemon's discovery record during self-repair

### macOS and Android timeline

- Keep a focused observed Claude, Codex, OpenCode, Antigravity, or Codex App
  session visible when session-list IDs carry an `observed:<provider>:` prefix
  but timeline events use the agent's raw session ID
- Mirror the same session-ID canonicalization in macOS, Android, and the Node
  per-session history query to prevent client-specific timeline gaps

### Stream Deck plugin

- **Published on the Elgato Marketplace** (approved 2026-07-28) — the plugin now
  installs in one click from
  [its Marketplace listing](https://marketplace.elgato.com/product/agentdeck-dce3806b-176e-40f2-be7d-e029bec0f464)
  instead of requiring a checkout and `streamdeck link`
- Remove MODEL key tiles entirely from passively observed Claude, Codex, and
  OpenCode sessions; model information without a deliverable selection action
  no longer occupies a button-shaped surface in idle, processing, or awaiting
  states

## 2026-07-22 — 1.0.1

Maintenance release across independently delivered channels — reliability fixes
that landed after the 1.0.0 build (03ed5a94) went to the App Store. Channels ship
on their own schedules; the iOS companion carries its fix on a later train while
1.0.0 finishes review.

### macOS app — App Store

- Fix the dashboard failing to attach to its own in-process daemon (WS connect
  handler was being clobbered and ports were mis-probed)
- Remove an actor-isolated closure that could trap at runtime
- Display-sleep correctness: re-sync `display_state` to clients, disarm two dim
  traps, and make iDotMatrix "off" render actually dark
- Recover a wedged ESP32 serial port by backing off instead of resetting the board
- Stop dropping whole tail windows on a split UTF-8 character (restores the Codex
  usage gauge)

### Stream Deck plugin — Elgato Marketplace

- Keep observed-agent processing details capability-aware on every keypad size:
  show the current model once as an inert readout instead of filling every unused
  key with duplicate `MODEL` tiles
- Preserve the notify-only Codex contract: processing details expose no steering
  action that the observed session cannot deliver

### Ulanzi plugin — D200H

- Publish the current self-contained 1.0.1 bundle for every declared macOS and
  Windows architecture
- Keep D200H rendering dark while the host display sleeps instead of allowing a
  later session repaint to wake the keys

### iOS companion (ships after 1.0.0 review completes)

- Hold the screen awake while the paired Mac's display is on

## 2026-07-20 — 1.0.0

First public release. Previous 0.x versions were development and TestFlight-only builds.

### macOS / iOS app — App Store

The macOS app is **standalone**: it embeds an in-process Swift daemon and needs no
Node.js, no CLI, and no companion install. The iOS/iPadOS app is a read-only
companion that pairs with a Mac on the same network.

- Live session dashboard for Claude Code, Codex, OpenCode, and OpenClaw — state,
  tool calls, timeline, and token/usage gauges
- APME evaluation — per-turn scoring, cost accounting, and a Pareto-frontier model
  recommender
- Device Preview gallery — 17 hardware surfaces rendered without owning any hardware
- Local-network pairing over Bonjour with QR-code enrollment
- Voice input via on-device speech recognition
- Opt-in Claude Code hook installer

Sandboxed with no subprocess execution, no home-relative-path entitlement, and no
App Groups; the local WebSocket accepts same-machine and paired-companion clients only.

### Stream Deck plugin — Elgato Marketplace

- Session-per-button keypad layout with encoder dials and a live touch-strip timeline
- Renders an explicit OFFLINE state when no daemon is present
- Requires the Stream Deck app 6.9+

### Ulanzi plugin — Ulanzi Marketplace

- D200H Deck Dock support through a single dynamic action whose keys reflow by agent
  state (sessions, options, mode, stop, usage)
- Ships `@resvg/resvg-js` native binaries for every declared macOS/Windows target
- Requires Ulanzi Studio 2.1.4+

### CLI and daemon — npm (optional)

`npx @agentdeck/setup` installs the `agentdeck` CLI, daemon hub, and lifecycle hooks
for Claude Code, Codex, and OpenCode. This unlocks the Tier-2 surfaces the sandboxed
app cannot reach — ADB-bridged Android devices, serial/BLE matrix displays, and
ESP32 WiFi OTA. Everything in the App Store app works without it.

### Android app — GitHub Release (APK)

E-ink-first dashboard for CremaS, Onyx, Kobo, and tablets. Not distributed through
Google Play.

### ESP32 firmware — GitHub Release

Prebuilt firmware for 86 Box, IPS 3.5", Round AMOLED, IPS 10.1", InkDeck (7.5"
e-ink), and TTGO T-Display. Flash over USB, then update over WiFi with
`agentdeck esp32-ota <target>`.
