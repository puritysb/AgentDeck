# 2026-10-14 — #273 phase 0: remove dead legacy managed-path code

First, behaviour-neutral step of the managed-PTY cleanup tracked in #273. The managed
launch path (`agentdeck claude|codex|opencode|monitor`) is untouched; only code with no
caller, or with a frame no client reads, was removed.

- The daemon no longer imports the managed `HookServer` module: `rgbToBmp` and
  `pixooLiveHtml` moved to `bridge/src/pixoo/pixoo-preview.ts`, shared by
  `daemon-server.ts` and `hook-server.ts`.
- `shared/src/d200h-layout.ts` lost the direct-HID grid (`computeLayout`,
  `buildLayoutMap`, `buildButtonCommandMap`, `KeySlot`, `GRID_COLS`), which had no
  importer. It was the only emitter of `mode_toggle` and `usage_toggle`, so the Swift
  daemon's `mode_toggle` / `session_switch` / `usage_toggle` handlers went too, and
  `session_switch` left the Swift Surface command map, which now matches
  [docs/surface-protocol.md](docs/surface-protocol.md). The D200H preview SYNC-HASH pin
  moved with no port.
- The session bridge stopped producing `encoder_state` / `button_state`. The Stream Deck
  and Ulanzi plugins and the ESP32 firmware never read them, and Apple and Android decode
  and drop them. The protocol types stay for wire compatibility.
- Swift: the daemon `StateMachine.suggestedPrompt` / `remoteUrl` (never assigned) and
  their `state_update` emitters, the unused `PluginCommand.navigateOption`, and the
  unreferenced `ActivityPanel.swift`. Android: the unreferenced `ActivityPanel.kt`,
  `sendSwitchMode()`, and `PluginCommands.switchMode` / `navigateOption`.
- `scripts/postinstall.sh` (superseded by `postinstall.mjs`) and the unused test helper
  `bridge/src/__tests__/helpers/mock-adapter.ts`.

Kept on purpose: the generated `navigateOption` / `switchMode` command builders,
because `scripts/generate-command-builders.mjs` derives them from `protocol.ts`. Also
kept: the `'pty'` transition source label on structured-adapter parser events. It is
only a debug string in Node, but it is the vocabulary of the shared transition table
that the generated Swift `StateTransitions` matches on, so renaming it is a
cross-surface change. Measured, not changed: `sessionDurationSec` is rendered by the
Stream Deck+ dial SESSION view and the IPS10 single-session fallback. For observed
sessions the Node daemon reports time since the last SessionStart its global machine
saw, and the Swift daemon reports 0. Turning that into hook-derived turn duration would
change what the field means, so it is out of scope here.
