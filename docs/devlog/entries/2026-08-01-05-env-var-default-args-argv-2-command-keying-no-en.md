# 2026-08-01 — Env-var default args: argv[2] command keying + `--no-env-args` escape hatch (PR #93 review)

The PR #93 review found two behavior gaps in the env-var default args
feature, both fixed on the branch after rebasing onto master (`8c65f438`,
which merged #53; the remote-attach option blocks and
`warnIfDaemonHostIgnored` derivation are preserved).

1. **Session-command detection now keys on `argv[2]`** instead of scanning
   every argv token for a session word. The scan spliced
   `AGENTDECK_COMMANDER_ARGS` into non-session commands whose positional
   value equals a session word — `agentdeck speak board1 claude` received
   the env args into `speak`. The CLI's top-level command position is fixed,
   so the decision reads exactly that token; regression added for the
   `speak … claude` shape.
2. **`--no-env-args` per-invocation escape hatch.** Env tokens land before
   typed flags, which lets a retyped *scalar* option win (last-write), but
   boolean flags (`--local`, `--no-postit`, `--no-adb`, hook-skip flags,
   `--remote-daemon`) have no inverse spelling — an env-provided flag was
   sticky and the docs over-promised "explicit CLI always wins". The new
   flag (registered on all four session commands) disables BOTH env layers
   for that invocation: the commander-layer splice is skipped pre-parse
   (raw-argv check — post-parse would be too late), and the per-agent weave
   is bypassed via `resolveAgentCommand` on `opts.envArgs`. A `--no-env-args`
   smuggled inside the env var itself is stripped so it cannot half-disable
   only one layer. Docs corrected to the scalar/boolean split
   (docs/cli.md, CLAUDE.md).

Tests now go through actual commander option parsing, not just argv-array
assertions: `parseOptions` on the real registered `claude` subcommand proves
env boolean sticks / hatch overrides / scalar last-write (incl. the
`parseWeight` processor), and a `parseAsync` end-to-end with a mocked
`startSession` proves the action wiring (woven vs unwoven command, env flag
present vs absent). Tokenizer examples corrected to real syntax
(`--remote-daemon --daemon-host u2.lan` — `--remote-daemon` takes no value).

---
