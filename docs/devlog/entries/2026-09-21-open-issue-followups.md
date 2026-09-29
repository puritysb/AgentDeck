# 2026-09-21 — Open-issue follow-up: quota relay and plugin reconnect recovery

Reviewed the six open issues after Apple 1.4.0 submission. This round implements
reproducible defects related to #348 and #303; it does not close either umbrella
or identify the Windows reporter's exact cause.

## Implemented

- **#348, focused-session usage relay:** read z.ai quota from the current cache
  with the existing ten-minute expiry and ended-window normalization at each
  relay, instead of forwarding the last built block indefinitely. This does not
  invoke the full usage builder or its Codex process-refresh path. The original
  capture time is preserved, and retirement remains an explicit windowless block.
- **#348, subscription consistency:** a Claude-bearing session bridge supplies
  replacement subscription lists without the daemon-owned z.ai plan. Reconcile
  that single provider row with the quota so it survives ordinary session ticks,
  changes once on plan replacement, and disappears with windowless retirement.
  Claude/Codex subscriptions and per-session counters remain intact.
- **#303, failed initial connection:** a never-opened WebSocket emitted no
  disconnect event, so the connection manager never quarantined its endpoint
  and could not try the next registered daemon. A distinct attempt-failed event
  now advances the existing candidate-selection policy.
- **#303, stalled handshake/retry:** bound the WebSocket handshake to five seconds.
  Retire the old socket before starting a new generation, including CONNECTING
  sockets. An explicit disconnect invalidates callbacks so a late close cannot
  schedule a reconnect. Real-socket tests cover a silent handshake, fallback,
  immediate retry during connection, and deliberate disconnect.

No provider keys are transferred. No UI, action UUID, profile, protocol schema,
version, installed daemon, store submission, or physical device was changed.
These source improvements need a later npm/plugin delivery.

## Remaining issue disposition

| Issue | Remaining work |
| --- | --- |
| #348 | Cross-daemon HTTP usage relay still needs explicit source/credential ownership and handover tests; the session-bridge fixes above do not implement that separate feature. |
| #349 | Existing z.ai dial implementation needs its marketplace/device delivery verification; no duplicate implementation added. |
| #303 | Re-test the installed Windows plugin and obtain a sanitized connection trace if OFFLINE persists; these reproduced defects do not establish the report's root cause. |
| #273 | Managed remote-attach and custom-argument replacements remain gated on real workflow parity; existing managed commands stay supported. |
| #272 | Board-specific delivery/repaint measurements and audio-hardware choice remain prerequisites to a new e-ink interaction design. |
| #314 | External store/publication-state follow-up remains separate from source fixes. Apple 1.4.0 submission is recorded in the preceding receipt. |

Validation: plugin connection tests (24) pass; the immediate-retry and explicit
disconnect regressions both fail against the pre-change source. Full
build/typecheck/test passed (303 suites); final counts are recorded in the PR.
Protocol generation has no drift, all seven token mirrors agree, and clean
baseline/current design lint both report the same 89 pre-existing violations.
Documentation/catalog/devlog gates pass. No installed Windows or physical
Stream Deck verification is claimed.
