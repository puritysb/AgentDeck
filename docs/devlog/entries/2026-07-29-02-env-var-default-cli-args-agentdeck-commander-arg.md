# 2026-07-29 — Env-var default CLI args: AGENTDECK_COMMANDER_ARGS / AGENTDECK_<AGENT>_ARGS

Added two layers of environment-variable defaults (`bridge/src/cli.ts`) so
flags retyped at every session can be set once in a shell profile.

- `AGENTDECK_COMMANDER_ARGS` — for the `agentdeck` (commander) layer.
  `applyGlobalEnvArgs` inserts the tokens right after the session subcommand
  (`claude`/`codex`/`opencode`/`monitor`), before user-typed flags — explicit
  CLI always wins (env = default). No-op for non-session commands
  (`daemon start` etc.).
- `AGENTDECK_CLAUDE_ARGS` / `AGENTDECK_CODEX_ARGS` / `AGENTDECK_OPENCODE_ARGS` —
  for the spawned agent command. `weaveAgentCommand` weaves onto an explicit
  `-c` instead of replacing it (`-c "claude --resume X"` +
  `AGENTDECK_CLAUDE_ARGS="--remote-control"` →
  `claude --resume X --remote-control`).

Tokenization (`tokenizeArgString`) is pure JS quote-grouping only and never
invokes a shell. The per-agent append rides the same platform shell path as
the existing `-c` (`pty-manager.ts`, POSIX `zsh -l -c` / Windows
`cmd.exe /d /s /c`). Windows caveat: `cmd.exe` does not treat single quotes
as quoting, so spaced values in the per-agent vars need double quotes
(recorded in docs/windows.md).

`monitor` spawns no PTY, so it has no per-agent var; only the commander-layer
var applies. Three unit-test groups (cli.test.ts): tokenization quoting rules,
argv splice position + no-op conditions, per-agent weave. User docs in
docs/cli.md (§ Sessions) and docs/windows.md; contract summary in
CLAUDE.md § CLI.

---
