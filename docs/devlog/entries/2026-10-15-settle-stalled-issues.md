# 2026-10-15 — Settle issues that were waiting on input that never came

The owner decided to stop waiting on stalled questions and apply the best
available decision instead. Each issue closes on a decision recorded in its
own doc, not on new measurements.

- **#273 / Discussion #278:** no workflow reports arrived. #273 closes on its
  second exit criterion, a documented decision to keep the compatibility
  path. The managed `agentdeck claude|codex|opencode|monitor` path is now a
  long-term compatibility path with no removal planned. New capabilities go
  daemon-first (`run`, `order`, `relay`). No Windows console-input rung, since
  the managed path covers that workflow
  ([docs/managed-replacement-inventory.md](docs/managed-replacement-inventory.md)).
- **#423, #425, #426 (Hermes):** the support stays as shipped, and its gaps
  are recorded per device rather than left blocking
  ([docs/hermes-agent.md](docs/hermes-agent.md)). The gaps are: no
  messaging-platform `/new` capture; iPhone installed without a visual review;
  Pantone and C6 unavailable; and no physical matrix/touch, long-run or
  photo/default-focus routing checks. Closing these issues records a decision.
  It does not claim the gates were met.
- **#428:** the bundled 3D model stays without the user's visual acceptance,
  and #428 is closed by hand as *not planned* after this merges, not as met.
- **#463 (deck control):** the three implementation phases shipped in 1.8.0.
  Of the four leftover measurements, OpenCode `variant` delivery and Codex
  config reload no longer matter, because OpenCode is not offered as a switch
  and Claude/Codex are readout-only. The Swift sandbox limit (Claude model
  from SessionStart only) is a known constraint. The Swift OpenClaw
  `sessions.patch` path stands on headless controller tests plus the Node
  live check.
- **#272 (e-ink voice panel):** no added audio hardware and no Swift pull-path
  parity for now ([docs/eink-face-research.md](docs/eink-face-research.md)).
  Representative-traffic and optical verification of the shipped panels move
  to #551 instead of being dropped.
