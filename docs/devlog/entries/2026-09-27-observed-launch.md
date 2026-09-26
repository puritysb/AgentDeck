# 2026-09-27 — Non-PTY local agent launcher

Issue #273 now has an additive local launch path: `agentdeck run` with claude,
codex or opencode. It uses the caller's terminal and the existing shell grammar
without loading the managed bridge or allocating a PTY. Existing command and
agent environment defaults keep their separate parsing rules; typed options win
and `--no-env-args` disables both. Unsupported managed flags fail explicitly.
Managed nesting is refused because its port marker would redirect observer hooks.

Regression coverage includes real shell execution with quoted executable paths,
arguments, redirects, cwd and exit status on the Windows Node matrix as well as
POSIX. Local terminal fixtures confirm inherited TTY input/output and Ctrl-C.
The real Claude smoke attempt hit the account weekly limit, so no successful
agent-response receipt is claimed. Remote two-machine parity and terminal-only
controls remain open; the original managed commands remain supported.
