# 2026-09-14 — Windows roster blanking and a hub with no way back to PROCESSING

Reported from a Windows 11 host: the dashboard showed four observed sessions
for a few seconds, then emptied, repeatedly; `GET /status` reported
`disconnected` while work was running. Diagnosed against the installed
`@agentdeck/bridge@1.3.3` and ported here.

`Get-CimInstance Win32_Process` measured ~10.4s on that machine across four
runs (bare `powershell.exe -NoProfile` startup is 0.55s there, and narrowing
the WQL projection does not help), so
[`collectProcessInfoWin32`](bridge/src/passive-observer.ts)'s 10s budget
timed out on every single scan. That is not what emptied the roster, though:
`collectProcessInfo()` reports a timeout, a spawn failure or unparseable output
as `[]` rather than throwing, so the `.catch(() => { this.cached = []; })` in
`collect()` never fired and the empty list flowed straight through `scan()` as
"every observed session ended". Three changes: the timeout is 30s, an empty
process table is treated as the third answer (could-not-look, retain the
previous roster) instead of as an empty machine, and a rejected scan keeps the
last roster too. `SCAN_INTERVAL_MS` stays at 5s but is now a floor — an 11s
scan on a 5s interval ran back-to-back forever, so `nextScanIntervalMs()` backs
the cadence off to the last scan's own duration, capped at 60s. Fast hosts are
unchanged.

The `disconnected` status was a separate defect in the hub's state machine. The
hub runs with `toolActivityRecovery: false` so one observed session's tools
cannot dismiss another's `AWAITING_*` prompt — but the guard returned before
every state, not just those, and the wildcard `session_end → DISCONNECTED` row
fires whenever *any* session ends. `session_start` was then the only edge out
and it never fires again for a session already underway, so the hub latched.
The guard now protects `AWAITING_*` prompts,
[`shared/src/states.ts`](shared/src/states.ts) gains a
`DISCONNECTED → PROCESSING` on `tool_activity` row (regenerated into the Swift
mirror), and tool activity during `PROCESSING` re-arms the stuck-timer backstop
the way `onPtyActivity()` does — without that, a hook-only session with no PTY
bytes decayed to `IDLE` after `STUCK_TIMEOUT_MS` however busy it was.

The verified evidence is from the patched install, not from this branch: 10
consecutive `sessions_list` broadcasts over 75s each carried all four sessions,
and `/status` moved from `disconnected` to `processing`. The slow-WMI root
cause is untouched — this accommodates it. Worth chasing separately: an
elevated `winmgmt /verifyrepository`, and whether an AV/EDR product is hooking
the `Win32_Process` provider.

### Maintainer review

The original contribution is preserved in PR #330. Behavioral tests reproduced
two gaps: scheduling from the scan start permitted immediate slow rescans, and
the hub's recovery guard skipped PROCESSING timer refresh. Slow scans now wait
their measured duration after completion (cooldown capped at 60 seconds), while
fast scans retain the 5-second start-to-start cadence. Tests exercise the real
scheduler, including rejected scans and overlapping collect calls. Hub and
session machines both refresh liveness during PROCESSING; held prompts remain
protected. The timer regression now runs with both recovery configurations.
