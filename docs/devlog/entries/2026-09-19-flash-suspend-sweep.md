# 2026-09-19 — #327 phase 3: the flash preflight sweeps the port window

The CLI half of the incident: `agentdeck esp32 flash` asked ONE daemon to
suspend — the registry's — and a transport timeout read as "no daemon". On
2026-09-13 that meant the blocked Node daemon was never suspended, the macOS
app's fallback daemon on 9121 (which the call never reached) kept the board,
and two writes corrupted. The preflight now suspends EVERY daemon in the
9120–9139 window and classifies each answer
(`sweepAndSuspendDaemons` in esp32-flash.ts, policy pure over injectable
probes, unit-pinned in `esp32-suspend-sweep.test.ts`):

- 2xx → suspended (tracked; all resumed in the `finally`, not just the
  registry's);
- ECONNREFUSED → nothing there;
- answered-but-not-2xx → `/health` decides: `mode: daemon` answering 404 is a
  pre-parity Swift fallback that would not stand down → REFUSE; a session
  bridge's 404 is not a serial holder → proceed;
- no answer at all → `scanTcpListener` (new `lsof -iTCP:<port> -sTCP:LISTEN`
  companion to `scanPortHolders`, same known/unknown taxonomy) names the
  listener: an AgentDeck process (`node`/`agentdeck`/`AgentDeck`) that cannot
  be reached cannot be asked to let go and its 10 s serial poll may still
  fire mid-write → REFUSE with the process name and pid; a foreign squatter
  or an unattributable listener is not a serial threat → proceed, and the
  "no daemon is listening" notice is reserved for ports that are genuinely
  refused-connection (a silent foreign listener is its own outcome, so the
  log never claims absence it did not observe).

Live three-arm check against real ports: a dummy silent `node` listener →
refused (`node(99596)` in the message — the incident shape now refuses
instead of proceeding); a dead port → proceed with the nothing-to-suspend
notice; the live Node daemon on 9120 → suspended, all eleven boards released
and re-opened, resume acknowledged HTTP 200. Validation: full vitest 4,560
passed, `pnpm -r tsc --noEmit` clean. Remaining #327 scope: phase 4 —
post-write reset/readback exercise under the same workload.
