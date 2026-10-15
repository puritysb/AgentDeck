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
- **#423, #425, #426, #428 (Hermes):** accepted as it stands, with three
  recorded gaps: no messaging-platform `/new` capture, no physical
  iPad/iPhone/matrix review, and the bundled 3D model accepted as shipped,
  with the re-sculpt not planned ([docs/hermes-agent.md](docs/hermes-agent.md)).
- **#463 (deck control):** the three implementation phases shipped in 1.8.0.
  Of the four leftover measurements, OpenCode `variant` delivery and Codex
  config reload no longer matter, because OpenCode is not offered as a switch
  and Claude/Codex are readout-only. The Swift sandbox limit (Claude model
  from SessionStart only) is a known constraint. The Swift OpenClaw
  `sessions.patch` path stands on headless controller tests plus the Node
  live check.
- **#272 (e-ink voice panel):** no added audio hardware, no Swift
  pull-path parity for now, and representative-traffic acceptance dropped as
  a gate ([docs/eink-face-research.md](docs/eink-face-research.md)).
