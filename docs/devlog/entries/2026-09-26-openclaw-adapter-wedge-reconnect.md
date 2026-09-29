# 2026-09-26 — OpenClaw adapter wedge: reconnect after a dead socket

### Incident

At 00:16 KST OpenClaw restarted itself (`gateway.restart`). The Node daemon's 5 s probe saw port 18789 open again and connected before the Gateway logged `gateway ready`, and the Gateway logged `closed before connect (handshake pending)`. The daemon log ended at `OpenClaw Gateway detected, connecting...`, `/health` reported `gateway: "disconnected"`, and OpenClaw was missing from every surface until a manual `agentdeck daemon restart`. This is the same wedge as 2026-09-16 (16.5 h).

### Cause

The daemon builds its adapter with `autoReconnect:false` and relied on the probe to replace it. The adapter never emitted `'exit'`, so the daemon's `adapter.on('exit', …)` cleanup was dead wiring. `startGatewayProbe` fired its connect callback only on the port's rising edge. While the Gateway process stays up, a dead socket therefore leaves a dead adapter forever.

### Fix

- The adapter emits `'exit'` when a non-reconnecting socket closes, and closes the socket on handshake failure or timeout.
- The probe calls `onAvailable` on every tick the port answers. The callee is idempotent. `onDisappeared` still fires only on the falling edge.
- The daemon only tears down the adapter if the `'exit'` comes from the current one. Adapters that die before completing the handshake back off exponentially from 5 s to 300 s.
- The Swift daemon's adapter runs its own reconnect loop and is not affected.

### Validation

`bridge/src/__tests__/openclaw-gateway-wedge.test.ts`: 2 of 3 fail without the fix and all pass with it. Build, typecheck and the full vitest suite pass. PR #380.
