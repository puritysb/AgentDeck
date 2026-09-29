# 2026-08-01 — Env-var default args: remote-attach opt-in wording + rebase onto #95 (PR #93 review round 2)

Second PR #93 review round. One contract-wording nit and a rebase:

1. **`docs/cli.md` no longer calls `AGENTDECK_REMOTE_DAEMON=1` and
   `AGENTDECK_DAEMON_HOST` "separate remote-attach opt-ins" (plural).** Under
   the #24/#53 contract only `AGENTDECK_REMOTE_DAEMON=1` is the opt-in switch;
   `AGENTDECK_DAEMON_HOST` is merely an endpoint hint and is inert without the
   switch (`deriveRemoteAttachOpts` sets `remote` from the switch alone, and
   `ignoredHostHint` when a host is given without it). The `--no-env-args`
   paragraph now states that distinction explicitly and ties the disable
   action to `AGENTDECK_REMOTE_DAEMON`, not to the host var. The PR body's
   matching plural framing was corrected the same way. The CLAUDE.md env-args
   block never mentioned remote attach, so it needed no change.
2. **Rebased onto master `64d196ea` (which merged #95).** #95 greened the
   Windows suite (LF working tree + platform-aware tests), so the rebased
   branch no longer carries the earlier Windows-host-only exception. Both
   PRs' `docs/windows.md` additions are preserved (#95's line-endings note,
   #93's `cmd.exe` single-quote caveat). The #53 remote-attach option blocks
   and `warnIfDaemonHostIgnored`/`deriveRemoteAttachOpts` derivation are
   intact.

---
