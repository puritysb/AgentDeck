# 2026-09-14 — Native Codex account refresh and TTGO telemetry verification

Swift now reads Codex account usage with native URLSession from the same
read-only endpoint used by upstream Codex: GET
https://chatgpt.com/backend-api/wham/usage. Credentials come from auth.json in
the existing user-granted Codex folder; no subprocess, token refresh, coupon
redemption, credential persistence, cookies, redirect or disk HTTP cache is
introduced. The endpoint is implementation-backed, not a public versioned API.

The daemon polls independently of rollout activity every 30 seconds; explicit
query_usage can refresh after five seconds, without bypassing failure backoff.
Requests have 8-second request/10-second resource timeouts. Failures preserve
the measurement timestamp, back off exponentially, and honor Retry-After.
Only the account rate_limit block is consumed. A successful account answer has
120 seconds of precedence over passive snapshots so an old session's newer
timestamp cannot restore pre-reset quota or substitute a model pool. Expired
live authority falls back by capture time; changing/removing credentials clears
native authority. No reset is inferred from a timeout or an absent window.

Swift serial diagnostics retain firmware-reported usageCodex5H/usageCodex7D
and deviceInfoCapturedAt. Authenticated GET /esp32/serial/telemetry?board=...
coalesces a fixed device_info_request through the owning serial connection and
returns 202; completion is verified by the new capture time in /health. This
avoids another serial reader and does not reset or flash the device. Waiting
for the serial actor inside the HTTP response stalled during fleet startup,
so a bounded, lock-protected queue is drained after usage delivery and the request is deliberately asynchronous and never claims enqueue is ACK.

Verification: build/typecheck pass, Vitest 4,494 passed (one skipped), native
macOS tests 21 passed, including coupon 100→0 without rollout changes, stale
session precedence, failure age/backoff, account isolation and malformed data.
Protocol generation has no drift; docs/catalog/tokens pass; clean-source
design lint has the same 89 findings as the base. A signed Debug build was
launched locally (PID 97103, port 9120); the installed store app is unchanged.
Live Codex account query and daemon both report weekly 4%; TTGO v1.3.0
firmware telemetry received on reconnect also reports usageCodex7D=4, usageCodex5H=-1 and zero write
backpressure. This verifies on-device state, not an optical panel capture.
No additional coupon was consumed and no firmware reflash was needed.

The final diagnostic queue advanced TTGO deviceInfoRequestsSent from 1 to 2,
but a second device_info reply was not observed within the 30-second check;
no newer deviceInfoCapturedAt is claimed. The verified 4% is the actual report
received on reconnect, not the queued request's result. Panel optics and
subsequent on-demand telemetry response reliability remain separate checks.
