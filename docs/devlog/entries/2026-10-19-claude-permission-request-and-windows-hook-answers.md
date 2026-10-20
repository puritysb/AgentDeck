# 2026-10-19 — Claude PermissionRequest as the prompt signal, and Windows hooks that carry the answer

**What the tester saw.** Ulanzi QA on Windows found two problems. A Claude
permission prompt reached the D200H more than five seconds after Claude drew
it. Deck STOP and Allow/Deny never reached Claude at all.

**Causes.**

- **The late prompt.** The deck's only Claude prompt signal was the
  `Notification` with `notification_type: permission_prompt`. The
  [hooks documentation](https://code.claude.com/docs/en/hooks) says to expect it
  "once you haven't typed for about six seconds", and points to
  `PermissionRequest` "to run a hook immediately". On Windows each hook also
  paid for a `/health` probe of up to 1 s, plus `Invoke-RestMethod`'s system
  proxy lookup, before it posted anything.
- **The dead answers.** The Windows `agentdeck-hook.ps1` piped every response
  to `Out-Null` and gave up after 2 s. A `PreToolUse` soft-STOP deny, a held
  gate's Allow/Deny, and a `Stop` directive all came back to a script that
  threw them away. The POSIX command prints those bodies; Windows never did.
- **The orphaned gate.** The Windows hook gave up after 2 s, but the daemon
  kept the Claude PreToolUse gate held for its full 25 s timer. For that time
  the deck offered Allow/Deny for a call Claude had already moved past. Node
  released a Codex hold when its socket closed, but not a Claude gate. The
  Swift daemon released neither.

**What changed.**

- **The hook.** `PermissionRequest` is installed by all three writers,
  byte-identically, with the tool matcher. It uses the existing bounded
  fire-and-forget command, so it prints nothing and never decides the dialog.
  Migration 13 adds it beside a user's own `PermissionRequest` hook.
- **The overlay.** Both daemons map the hook to the same display-only
  `awaiting_permission` prompt as the Notification, carrying the tool
  ("Allow Bash: rm -rf build"). The later Notification never replaces a prompt
  that is already shown, so one dialog counts once. Neither signal replaces a
  held gate, whose `requestId` is the device's only way to answer, or an
  AskUserQuestion prompt. The prompt is cleared by the same tool and turn hooks
  as before.
- **Windows ps1.** The script makes no `/health` probe and no proxy lookup
  (`HttpWebRequest`, `Proxy = $null`). It posts to the `daemon.json` port and
  tries 9120 only on a refused connection. `PreToolUse` (60 s) and `Stop`
  (10 s) write the daemon's UTF-8 body to stdout, the same bounds as the POSIX
  `--max-time`. Every other event is 0.8 s fire-and-forget.
- **Socket close.** Both daemons release a held Claude PreToolUse gate,
  ask-gate or Codex hold as `pass` when the hook's HTTP socket closes. Swift
  does this through a task-local `HTTPRequestContext.peerClose`, which a
  one-byte receive on the request's `NWConnection` fires at EOF or on an
  error.

**Rejected.**

- **Answering the dialog from `PermissionRequest`.** Hooks block by default, so
  holding this hook would hold up Claude's own dialog. That is the cost the
  Codex hold pays with "Running hook". The PreToolUse gate is already the one
  channel that answers a call; a second channel for the same decision would
  race it.
- **Letting `PermissionRequest` overwrite a held gate's prompt.** Its question
  is the same, but the overwrite would drop the `requestId`, and with it the
  device's Allow/Deny.
- **`Invoke-RestMethod -NoProxy`.** Windows PowerShell 5.1, the `powershell`
  the hook command names, does not have that parameter.
- **Keeping the probe but shortening it.** A refused connection is the same
  evidence the probe gathered, and it costs nothing when the daemon is up.
- **In Swift, watching `NWConnection.state` instead of a receive.** The state
  does not change on a peer's FIN until something reads from the connection.

**Costs and limits.**

- **A small delay before the dialog.** Because hooks block by default, the
  fire-and-forget hook can delay Claude's dialog by up to its 0.8 s bound when
  the daemon is up but not answering. When nothing is listening, the delay is
  the 0.2 s connect bound.
- **Brief false prompts.** In `-p` mode and for background subagents,
  `PermissionRequest` still runs, and a call no hook decides is denied without
  a dialog. That can show a short false prompt until the next tool or turn hook
  clears it.
- **No resurrection on the Swift side.** Swift shows the prompt only on a row it
  already has. After a daemon restart mid-session, the Notification is still
  what resurrects the row.

**Not verified.**

- **Windows.** Nothing was run on a Windows machine. The executed ps1 cases in
  `hooks/src/__tests__/install.test.ts` run only on win32 and are listed for
  the `windows-runtime` CI job, which has not yet run them.
- **Timing.** The time from Claude's `PermissionRequest` to its dialog was not
  measured, and the documentation does not say whether the dialog waits for
  the hook.
- **Real clients.** No real Claude process drove either daemon. The Node e2e
  stands up a process named `claude` (a symlink to `sleep`) with its session
  file, and the Swift path is covered by XCTest only. The prompt was not looked
  at on a physical D200H.
