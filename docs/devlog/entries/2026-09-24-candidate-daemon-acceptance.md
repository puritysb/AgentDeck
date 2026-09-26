# 2026-09-24 — Candidate installed daemon acceptance

Verified the npm 1.4.3 candidate from `1a40fe5c` through the real installed
`agentdeck` path, with Apple 1.5.1 (local build 4), development-signed Release
from the same source. The separate distribution-signed CI export receipt remains
1.5.1 (7401), source `5c8b6445`; no store artifact was modified or uploaded.

## Results

| Mode | Measured result |
| --- | --- |
| CLI only | Installed four candidate tarballs; Node 26.5.0 / ABI 147, SQLite 12.11.1 ready. PID 37809, build `4f057a9de4eb`, sole listener on 9120. A directly launched Codex turn ran a timing command and returned `CLI_143_OK`; Stream Deck showed the working session, and the app subsequently displayed its completion. Ten steady-state health samples passed, maximum 8 ms. |
| Swift only | PID 31219, `isSwift: true`, 9120. A directly launched Codex turn returned `SWIFT_9120_OK`; Dashboard and Stream Deck both showed working state, then completion. Ten steady-state health samples passed, maximum 7 ms. |
| Both / recovery | The app attached to the CLI on 9120 with a single listener and no observed duplicate roster. Stopping the supervised CLI promoted Swift: temporary 9121 at 09:45:06Z, automatic canonical reclaim at 09:47:07Z and listening on 9120 at 09:47:11Z. No app restart or hook reinstall was used. |
| Swift exit → CLI | Candidate started at 09:48:03.900Z and bound 9120 at 09:48:30.143Z, about 26.24 seconds later, without fallback. Running identity matched the installed build. |

The two-minute Swift failed-bind cooldown is existing behavior; it recovered
automatically. Earlier CLI health sampling deliberately overlapped shutdown:
eight responses followed by two connection failures, so it is not a clean
steady-state series. The ten-sample results above are the separate completed
series. Python's default URL opener initially timed out through system proxy
handling; direct no-proxy requests and curl answered promptly. This was not
counted as a daemon failure.

Initial standalone Claude execution was blocked by account subscription policy.
The default Codex CLI/model combination was rejected as too old, and a legacy
model attempt was unsupported for the account. Those attempts do not count as
successful agent turns. The successful probes used the supported Codex 5.5 model.
No account settings or CLI installation were changed to bypass those restrictions.

## Restoration and remaining physical gate

Restored the original global package directory and CLI link to the persistent
main checkout, plus macOS 1.5.0 (4). Supported lifecycle start restored launchd
PID 43034, build `e30d55a7714e`, on 9120; the app reattached with downstream devices.
`pnpm plugin:check` passed: existing development bundle `ef7d18b7e87c`, PID 60701.
Candidate artifacts and private raw evidence are retained under the task worktree's
ignored diagnostics directory. No hooks, firmware or iOS device installs changed.

Elgato #349 remains incomplete: the official processed package's physical
rotation/press/touch gate requires an operator. A request for that participation
is pending. The development plugin was not replaced while awaiting the response.
Do not convert display observations into a physical interaction receipt.

Publication remains on hold. This receipt covers the recorded candidate; a later
release with changed executable inputs requires renewed relevant acceptance.
