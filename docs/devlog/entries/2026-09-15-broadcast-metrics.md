# 2026-09-15 — Broadcast interval counters for e-ink measurement

Follow-up to #272: the Node daemon now exposes cumulative broadcast-attempt
metrics through the existing protected health response. Three fixed counters
reuse broadcastActionability; a random server instance ID separates restarts,
with epoch timestamps and monotonic elapsed time for interval comparisons.
Snapshots cannot mutate the counters. No frame or session content is retained.

This is server-wide instrumentation, not per-panel delivery or repaint data.
It counts once per broadcast even without clients or when a relay fails; direct
per-client sends are excluded. Swift and older Node installations omit the
field, which means unavailable. The public LAN health allow-list is unchanged.
The research document explains the denominator, restart boundaries and pairing
with board counters. The actual 24-hour field measurement remains outstanding.

Validation: build and typecheck passed; 4,517 tests passed with two platform
skips, including mixed classifications, failed relay, snapshot isolation and
new-server identity. Protocol generation left no drift; token and documentation
checks passed. No runtime installation, device flash or release was performed.
