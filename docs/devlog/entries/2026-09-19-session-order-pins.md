# 2026-09-19 — Observed-session order pins (#273 session-ordering gate)

Issue #273's "Session ordering" gate named the gap precisely: `--weight` is a
launch-time flag of the managed PTY path, and a normally launched observed
session (direct `claude`/`codex`/`opencode` with the daemon installed) has no
launch line to hang a flag on, so it could not be ordered at all — and any
daemon-side pin would have had no storage, since observed rows are in-memory
only in both daemons.

The daemon-first replacement now exists on the Node daemon. `SessionOrderStore`
(`bridge/src/session-order-store.ts`) persists weight pins in
`~/.agentdeck/session-order.json` — daemon-written like `timeline.json`,
atomic tmp+rename — keyed on the **bare** session id (`rawSessionId`), so
`observed:claude:<uuid>` and the uuid a hook carries address the same pin.
Lifecycle rules are explicit and tested: pins survive daemon restarts, a
resumed session (`claude --resume <uuid>`) re-picks-up its pin because the id
is unchanged, `lastSeenAt` advances on every roster the daemon builds
(throttled, debounced persist), a pin unseen for 30 days is GC'd, and at most
256 pins persist with least-recently-seen eviction. The daemon overlays pins
in the sessions enricher **before fold+sort** onto observed rows **without
their own weight only** — managed `--weight` and remote pushed weights always
win, and weight 0 is a clear, not a pin. No wire change: the value rides the
existing `SessionInfo.weight`, so the Codex display fold's weight-band key
keeps distinct pins unfolded on every surface.

Surface: `GET/POST /sessions/order` (standard LAN auth gate; prefix/uuid id
resolution with ambiguity refusal; mutation triggers an immediate
`sessions_list` rebroadcast) and `agentdeck order set|clear|list`. The managed
compatibility notice no longer claims ordering lacks a daemon-first
equivalent. Honest limits, stated in docs/daemon.md and the feature matrix:
the Swift daemon neither reads the file nor serves the route (the CLI names
the takeover command), and the gate's real-user tab-to-deck scenario remains
open — this lands the mechanism and its rules, not the validation that would
let the managed path retire.

Validation: new `bridge/src/__tests__/session-order-store.test.ts` (identity
both id forms, 0-clears, clamping, persistence round-trip, corrupt-file
tolerance, TTL GC, 256-cap eviction, noteSeen throttling, overlay precedence,
prefix resolution, weight validation, and pinned-observed rows through the
shared fold+sort pipeline incl. the never-fold distinct-pins case) — 87 tests
green in that file plus cli.test.ts over the revised notice; `pnpm build`,
`pnpm typecheck` clean.
