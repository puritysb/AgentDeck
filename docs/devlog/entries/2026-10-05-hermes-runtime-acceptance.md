# 2026-10-05 — Exercise Hermes runtime recovery, packaging and native delivery

Extended [Hermes acceptance evidence](docs/hermes-agent.md) for
[#426](https://github.com/puritysb/AgentDeck/issues/426) and
[#425](https://github.com/puritysb/AgentDeck/issues/425), using the pinned
managed upstream runtime and deterministic loopback provider.

- Repeated the post-fix silence TTL with real elapsed time. An open Hermes
  APME run closed 1,819.485 seconds after its last callback while Gateway stayed
  alive. No fake clock or shortened expiry was used. The optional Unix tick
  socket warned about the long temporary path; HTTP/Gateway remained usable.
- Kept a real Gateway alive across an isolated Node restart. Timeline/APME
  retained the first turn, omitted the offline second turn, and received the
  third turn. Both recorded turns ended as `stop`; no lost prompt was replayed.
- Executed 90 real terminal calls against a slow receiver. The queue reached
  its 128-item cap; callback enqueue stayed below 0.508 ms and CLI exit was 0.
  The receiver saw nine requests and no final Stop. This measures lossy,
  nonblocking congestion behavior, not reliable callback delivery.
- Measured actual CLI exit flush around its unchanged implementation: 1.005
  seconds, 55 pending events reduced to 30. Exit is bounded; pending callbacks
  do not survive process exit.
- Verified the installed 1.7.0 installer preserves configuration during
  install/update, with real Hermes enable/disable/enable commands in an isolated
  profile. Both published Python/manifest assets matched current source.
- Ran a development-signed QA Swift app on a separate port/data directory.
  Its actual HTTP/WS/APME path accepted a real delegated turn with one parent
  reply, one closed run and one `stop` turn. This is not sandbox acceptance.
- Observed the real CLI WORKING row in installed macOS TestFlight 1.7.0 (7701)
  via the supported Node relay path. This verifies the sandbox dashboard relay,
  not direct sandbox profile discovery or approval of the current 3D model.
- Updated connected Lenovo from 1.6.1 to the official 1.7.0 APK (code 24).
  Inspected an actual Hermes WORKING row and its finalized timeline reply.
  Generated 24/16/9/8 px marks were inspected locally; physical matrix review
  and replacement-model approval remain open.

No production daemon lifecycle change or paid provider call was required.
Local screenshots and diagnostic scripts are not committed. Runtime app
launch through Launch Services succeeded after direct execution of the QA
binary was terminated by the host. Corrected the CLI installer's Node-only
requirement wording to describe a Hermes-capable daemon, matching measured
Swift ingestion. Runtime behavior and App Store discovery restrictions remain
unchanged.
