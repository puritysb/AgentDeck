# 2026-09-19 — #327 phase 4: flash under load end-to-end, and the ack-first suspend

Phase 4 exercised the whole chain on the incident's own board (TTGO
T-Display) — and the desk supplied incident-grade load for free: an external
spike (Stream Deck + simulator runtimes) drove the host to load 325–466
during the first attempt, exactly the 2026-09-13 regime.

First attempt at that load: the phase-3 sweep REFUSED the flash — "AgentDeck
did not answer within 10s on :9120 (node(41410))" — no bytes touched the
board, which is the guard doing precisely what it was built for (the 09-13
attempt proceeded and corrupted two writes). Two facts from the same event:
/health answered in p99 54 ms at load 440 (the phase-1 async fix holding),
and the suspend call still starved — its ack was queued BEHIND the port
release, and the request landed after the CLI had given up, releasing eleven
ports with nobody tracking a resume. The lease self-healed that by expiry,
as designed. The suspend handler now writes the lease (the authority; every
poll cycle checks it before opening, so no reopen can race the gap), responds
IMMEDIATELY, and releases the ports on the next tick — the ack no longer
waits on device work.

Second attempt under controlled load (10 spinners) on the new handler:
sweep-suspend acknowledged in budget → 2.6 MB written in 137.8 s at the
board's default baud → MD5 verified → post-write reset and identity readback
reported `ttgo_t_display 1.3.0 (dfcc6865)` — the same image, idempotent, exit
0. The resume call at the end timed out against another external spike and
was reported as such; the lease expired ≤420 s later and all eleven boards
reopened, which is the designed convergence when a resume is lost. Every
element of the recorded incident chain now has a measured countermeasure:
load attribution and /health telemetry (df6bb485), Swift serial ownership +
flash-lease parity (60ccdd6d), the CLI port-window sweep (a2aebfba), and the
ack-first suspend + live write/reset/readback under load (this change).
Validation: full vitest 4,560 passed, tsc clean.
