---
id: validation.ulanzi-plugin
title: Ulanzi Plugin Verification
description: How to verify the D200H plugin without hardware or Ulanzi Studio, and what the hardware pass adds.
category: Engineering
locale: en
canonical: true
status: stable
owner: Plugin maintainers
reviewed: 2026-08-07
revision: 2026-08-07
source_of_truth: plugin-ulanzi/VERIFY.md
validators: [pnpm test]
---
# Verifying the AgentDeck Ulanzi plugin (no hardware / no Ulanzi Studio needed)

The official SDK ships a browser **UlanziDeckSimulator**. It renders a virtual
D200H, loads our plugin's actions from its manifest, and runs the WebSocket bridge
on `127.0.0.1:39069`. Our Node main service connects to that bridge exactly as it
would to Ulanzi Studio.

Already set up for you:
- SDK cloned to `tools/ulanzi-sdk/` (gitignored), simulator deps installed.
- Our plugin symlinked into `tools/ulanzi-sdk/UlanziDeckSimulator/plugins/`.
- Action icons generated under `…/resources/icons/`.

## Steps

1. **Build the plugin** (emits the main service):
   ```bash
   pnpm --filter @agentdeck/plugin-ulanzi build
   ```

2. **(Recommended) Run a daemon with a live session** so tiles have content —
   in its own terminal:
   ```bash
   agentdeck daemon start --foreground
   ```
   Start a Claude/Codex/OpenCode session so it reaches an `awaiting`/`processing`
   state (that's what animates).

3. **Start the simulator** (its own terminal):
   ```bash
   cd tools/ulanzi-sdk/UlanziDeckSimulator && npm start
   ```
   Open <http://127.0.0.1:39069>.

4. **Start our main service** (its own terminal — runs from the workspace so
   `node_modules`/`@agentdeck/shared`/resvg-wasm/gifenc resolve):
   ```bash
   pnpm --filter @agentdeck/plugin-ulanzi sim
   ```
   Expect logs: `daemon connected`, `Ulanzi Studio bridge connected`.

5. **In the simulator UI**: find the **AgentDeck** plugin in the action palette,
   drag the single **AgentDeck** action onto several keys — each key reflows by
   agent state (session, option, mode, stop, usage), then watch:
   - tiles render text + creatures (font fix),
   - an `awaiting`/`processing` Session key shows an **animated GIF** — an amber
     border breathing on `awaiting`, a teal dash orbiting the key on `processing`
     (see [Animation](#animation) for what a correct loop looks like),
   - pressing a key dispatches a command — confirm with `agentdeck daemon status`
     (e.g. button press count / focus change) or the daemon log.

## Animation

Ulanzi Studio plays and loops a GIF on the device itself, so unlike the Stream
Deck plugin — which pushes a fresh image every 150ms tick — this plugin pushes
**one GIF per state transition** and then goes quiet. Steady-state animation costs
nothing on the link.

What that buys has to be paid for at encode time, so three properties are worth
checking whenever the tiles or the schedule change:

- **The loop must close.** A GIF spans exactly one `SESSION_SLOT_ANIM_CYCLE`
  (`shared/src/svg-renderers/session-slot-renderer.ts`), sampled at
  `ANIM_FRAMES` even steps. Any other span leaves the orbiting dash mid-travel at
  the wrap, and the tile jumps once per loop. A live ticker cannot have this bug,
  which is why it went unnoticed; `shared/src/__tests__/session-slot-anim.test.ts`
  and `src/__tests__/anim-schedule.test.ts` are the gates.
- **A key press must stay responsive.** Encoding shares the thread that serves
  Studio's socket, so it runs off the render path a frame at a time: a changed key
  ships its static PNG immediately and upgrades to its GIF when ready. If BACK
  feels sluggish, that path regressed.
- **Keys must not move as one block.** Each key starts its loop at a different
  point in the cycle (`phaseOffsetFor`), so a deck of busy sessions reads as
  several independent activities rather than one synchronised light show. Because
  the frames are an even sample of the cycle, this is a rotation of the frames
  already rendered and costs nothing. If every tile pulses in unison, the rotation
  was lost; if no tile animates at all, the rotation and the encoder's staleness
  check have disagreed (see `frameOrderFor`).
- **Payload stays modest.** Frames are written as delta frames (only pixels that
  changed from the previous frame, GIF disposal 1) over one shared palette, at the
  native 144 canvas rather than `ICON_SIZE`. Expect roughly 21–24 KB for a
  `processing` tile and ~47 KB for `awaiting`; a sudden jump back to ~70 KB means
  the delta or palette path broke.

Set `AGENTDECK_ULANZI_ANIM=0` to fall back to static PNG tiles — useful for
isolating whether a device-side rendering problem involves animation at all.

### What the push path can and cannot tell you

An image push is never acknowledged: neither Studio nor the device replies, and
the plugin's inbound events are all input and lifecycle. **A frame the panel
dropped is indistinguishable from one it drew**, so "is the device keeping up?"
has no software answer here — only the panel itself does. Two things *are*
measurable, and both were taken on hardware on 2026-08-07:

- **Our socket's send queue** (`peak socket queue` in the `push burst` log line).
  It was **0 B in every burst**, including a whole 13-key repaint of 136 KB
  offered in 38 ms with pacing removed (`AGENTDECK_ULANZI_PUSH_PER_TICK=99`,
  ≈3.6 MB/s). Studio accepts everything offered; the plugin→Studio leg is nowhere
  near saturation, and the per-tick pacing below is throttling for a downstream
  we cannot see rather than for this socket.
- **Studio's own CPU**, compared across restarts with animation on and off (the
  only way to separate push cost from Studio's startup work). Animation on:
  1.39 and 1.31 CPU-seconds, settling to idle at 2.0 s. Animation off, same
  repaint minus every GIF: 1.43 CPU-seconds, also 2.0 s. **The ~112 KB of extra
  GIF payload costs no measurable Studio time** — the run-to-run spread with an
  unchanged config (1.31 vs 1.39) is wider than the on/off difference.

So the animation is not something the link has to absorb continuously: after the
loops land, the plugin goes silent (a 90 s idle window showed zero re-renders)
and the device plays them by itself. If the panel ever *does* fall behind, the
first thing to check is the encode/push log above, not the socket.

## Notes
- The main service auto-discovers the daemon port from `daemon.json` (Node CLI or
  App Store Swift sandbox), validates `/health`, and falls back to loopback 9120
  when the registry is unavailable (including Windows Studio + WSL2). Registry
  PIDs do not need to exist in Studio’s process namespace. Custom ports require
  a registry entry; an explicit `AGENTDECK_DATA_DIR` disables the fallback.
- `AGENTDECK_DEBUG=1` (set by `pnpm sim`) enables verbose logs.
- This whole path is dev tooling; nothing here ships in the App Store app.

---

## Real Ulanzi Studio + hardware (recommended over the simulator)

The simulator's key grid is generic and doesn't match the real D200H or D200X.
To test on the actual device, install into **Ulanzi Studio** — which launches the Node main
service itself from the installed plugin folder, so the plugin must be
**self-contained** (bundled app.js + `resources/resvg.wasm` + a shipped
`node_modules` holding only `ws` — no native binary on any platform).

1. **Install Ulanzi Studio for Mac** from <https://www.ulanzi.com/pages/downloads>
   (Apple silicon build), launch it once, plug in the D200H or D200X.

2. **Build + install the self-contained package** (one command):
   ```bash
   pnpm --filter @agentdeck/plugin-ulanzi package:install
   ```
   This bundles the main service, stages `resources/resvg.wasm` and `ws`, and
   copies the `.ulanziPlugin` into
   `~/Library/Application Support/Ulanzi/UlanziDeck/Plugins/`.
   (Omit `:install` to only build under `plugin-ulanzi/dist/`.)

3. **Restart Ulanzi Studio.** The **AgentDeck** plugin appears in the action list
   with its single dynamic **AgentDeck** action.

4. Drag that action onto all D200H or D200X LCD keys, run a daemon + agent session,
   and verify on real hardware: tile rendering, GIF animation on
   awaiting/processing, and key-press dispatch. D200X encoder rotation, press,
   and dial-area feedback are a separate unimplemented action and are not part
   of this keypad pass.

Debug the Studio-launched Node service: launch Studio with
`open "/Applications/Ulanzi Studio.app" --args --nodeRemoteDebug`, then open
`chrome://inspect`.

## Windows / WSL2 evidence and community verification

The Windows Node 22/24/26 CI matrix runs daemon discovery, client and native
transport tests. Missing registries fall back to the canonical hub; registry
PIDs from another process namespace are not checked as Windows processes. Real
temporary files and loopback HTTP/WebSocket peers verify health gating, plugin
registration, frame/command exchange and reconnect after a changed registry port.
These peers model the namespace mismatch; CI does not boot WSL2, run Ulanzi
Studio's bundled Node, or inspect physical keys.

A discovery fix can be closed after its source and automated gates pass. Track
physical acceptance separately in the current release delivery issue. Lack of a
Windows device alone does not hold unrelated platform releases; failing CI or a
confirmed regression holds the affected delivery until addressed.

For a Windows 11 + WSL2 + D200H/D200X community check:

1. Install the fixed Ulanzi plugin (1.7.0 or newer) from the approved Marketplace
   listing, or the matching official GitHub Release package. Record Windows, WSL,
   Node, Studio, daemon and plugin versions and the plugin installation source.
2. Start the daemon normally inside WSL2 and open Studio on Windows. Do not copy
   Linux `daemon.json` or spoof a Windows PID. Put AgentDeck actions on device keys.
3. Confirm the keys leave OFFLINE, show the expected session state, and update
   after an ordinary session changes state. Record a screenshot or short video.
4. Restart the WSL daemon with `agentdeck daemon restart`; confirm the plugin
   reconnects and key updates resume. Also restart Studio and confirm initial
   discovery still works.
5. Report pass/fail and elapsed reconnect time on the delivery issue. For a
   failure, include sanitized Studio plugin logs and whether Windows can reach
   the daemon health endpoint. Never post the full health JSON: it may contain a
   pairing token. Exclude tokens, credentials, prompts and private file paths.

A reproducible failure reopens the original bug or gets a linked regression
issue. A proposed PR should include a reproducer and an automated regression case
where possible. A community pass extends hardware evidence; it does not change
what CI proves.
