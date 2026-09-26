---
paths:
  - "bridge/src/cli.ts"
  - "bridge/src/pty-manager.ts"
  - "bridge/src/adapters/pty-adapter.ts"
  - "bridge/src/adapters/claude-code.ts"
  - "bridge/src/adapters/codex-cli.ts"
  - "bridge/src/adapters/opencode-adapter.ts"
  - "bridge/src/adapters/monitor.ts"
  - "docs/cli.md"
---
# Managed sessions (CLI, PTY)
<!-- Moved verbatim from CLAUDE.md (2026-09-10). Rule bodies are the SSOT for their domain; CLAUDE.md keeps only the map. -->
The legacy `agentdeck claude|codex|opencode|monitor` PTY path stays a product contract during the compatibility
window (#273 / #278). CLI reference: [docs/cli.md](../../docs/cli.md).

## Session sort weight

**Session sort weight**: session commands (`claude`/`codex`/`opencode`/`monitor`) accept `--weight <n>` (integer in **-9999..9999** — `SESSION_WEIGHT_MIN/MAX` in `shared/src/session-utils.ts`, emitted to Swift/Kotlin via `pnpm generate-session-weight-rules`; default 0) — an explicit deck/tab sort override. `sortSessions` (SSOT `shared/src/session-utils.ts`, hand-mirrored in Swift `DashboardDataRules`, Kotlin `EinkFormatUtils`) orders by **weight ascending first** (negatives → unweighted/0 → positives), then the existing agentType→project→startedAt→id keys; weight also joins the Codex display-fold key so distinct pins never fold together. Comparators are three-way, never subtraction. Threads CLI → `SessionOptions.weight` → `SessionEntry.weight` (registry) → `session_push_register` + `SessionInfo.weight` (wire, sanitized at daemon boundaries) → every surface. Lets a user pin Windows Terminal / iTerm tab order onto the Stream Deck. Leaving all weights at 0 reproduces the pre-weight ordering. See [docs/cli.md → Pinning session order](../../docs/cli.md#pinning-session-order-with---weight).

**Daemon-persisted order pins for observed sessions (#273)**: `agentdeck order set/clear/list` → `POST/GET /sessions/order` → `SessionOrderStore` (`bridge/src/session-order-store.ts`, `~/.agentdeck/session-order.json`, atomic tmp+rename, daemon-written like timeline.json; **Swift near-transliteration** `apple/AgentDeck/Daemon/Session/SessionOrderStore.swift` reads/writes the same file and serves the same routes with byte-compatible responses). Keys are the **bare id** (`rawSessionId`) so both id forms address one pin; TTL 30 days from last roster sighting and pin cap 256 are a cross-daemon file contract single-sourced in `shared/src/session-utils.ts` (`SESSION_ORDER_TTL_MS`/`MAX_SESSION_ORDER_PINS`, emitted to Swift/Kotlin via `pnpm generate-session-weight-rules`). Both daemons overlay pins **before fold+sort** onto observed rows **without their own weight only** — a managed session's launch-time `--weight` and a remote session's pushed weight always win, and weight 0 is a clear, not a pin. No wire change: the value rides `SessionInfo.weight`, so the Codex fold's weight-band key keeps distinct pins unfolded. Do not remove the managed `--weight` path until the real-user tab-to-deck scenario in #273 validates the replacement.

## Env-var default args

**Env-var default args** (`bridge/src/cli.ts` — `applyGlobalEnvArgs`/`weaveAgentCommand`/`resolveAgentCommand`): `AGENTDECK_COMMANDER_ARGS` injects flags into the `agentdeck` (commander) layer — spliced into argv right after the session subcommand, **keyed on `argv[2]`** (`claude`/`codex`/`opencode`/`monitor`; any other command ignores it, even with a session word as a positional value). Env tokens land before typed flags: scalar options are overridden by retyping (last-write); boolean flags have no inverse spelling, so the per-invocation override is **`--no-env-args`**, which disables BOTH layers (the splice pre-parse, the per-agent weave in the action). `AGENTDECK_CLAUDE_ARGS` / `AGENTDECK_CODEX_ARGS` / `AGENTDECK_OPENCODE_ARGS` append to the spawned agent command, weaving onto an existing `-c` (e.g. `AGENTDECK_CLAUDE_ARGS="--remote-control"` + `-c "claude --resume X"` → `claude --resume X --remote-control`). The per-agent append rides the same platform shell path as `-c` (`pty-manager.ts`); the global var is tokenized in pure JS and never touches a shell.

## node-pty macOS helper mode

**node-pty macOS helper mode** (`bridge/src/pty-manager.ts`): stable `node-pty@1.1.0` is published with both Darwin `spawn-helper` prebuilds at mode 0644 (upstream microsoft/node-pty#850/#919), so the native addon imports but its first spawn fails with the misleading generic `posix_spawnp failed`. Before the dynamic import, `PtyManager` resolves the actual installed package and adds only the missing execute bits to a regular helper file (prebuild first, source-build fallback). This runtime repair intentionally covers direct bridge installs as well as `@agentdeck/setup` and does not depend on npm/pnpm install scripts. Never replace it with an import-only probe; the measured failure occurs only at spawn.


## Non-PTY local launch

`agentdeck run <claude|codex|opencode>` is additive. It composes the same shell
command and agent-specific defaults, then inherits the caller's terminal without
a PTY or per-session bridge. The commander defaults are inserted immediately
after `run`, before typed arguments; `--no-env-args` disables both layers.
Unsupported managed-only options must fail rather than be silently ignored.
A managed `AGENTDECK_PORT` marker refuses launch to prevent hook misrouting.
Remote control and terminal-only affordances still use the managed path; this
launcher is not evidence that those replacement gates in #273 are complete.
