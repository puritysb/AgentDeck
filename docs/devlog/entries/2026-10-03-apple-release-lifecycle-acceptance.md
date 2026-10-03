# 2026-10-03 — Apple release lifecycle acceptance

## Findings and changes

- Both Codex installers now send the launching POSIX process PID through the
  real lifecycle command shell. A loopback regression verifies the header and
  unchanged stdin payload. Existing user settings and hook trust records are
  preserved; Codex still requires normal trust for changed commands. Windows
  remains a separate follow-up in #429.
- Real Hermes CLI and Gateway conversations produced a scrubbed callback
  fixture: multi-turn, CLI reset/exit, cancellation, terminal work, two profile
  homes, Gateway shutdown and invalid-model finalization. Node HTTP ingestion,
  roster/timeline frames and SQLite APME records were inspected. See
  [Hermes evidence](docs/hermes-agent.md).
- Cancelled turns were correctly classified by APME but labelled Completed in
  the Node timeline. The label now follows the actual interruption/failure flag.
- Gateway tool callbacks omit platform. The observer now retains bounded
  conversation context instead of relabelling them CLI and exporting host cwd.
  A repeat through the real Gateway verified the corrected outbound payloads.
- A quiet Gateway run remained open in APME after its 30-minute roster TTL.
  Node and Swift expiry now close that run; Swift uses the Hermes chat anchor
  to close any pending timeline turn.

## Release status at this checkpoint

The earlier Apple 1.7.0 upload is build 7601; iOS TestFlight reports Ready to
Submit. It does not contain these fixes and must be replaced. No version has
been added to App Review or submitted by this work. Physical iPad Air and
iPhone 14 Pro Max are unavailable. The current bundled USDZ was rendered with
RealityKit for the owner’s pending visual acceptance; it is not an in-app iPad
capture. Broader #426 child/messaging-platform cases remain separate from the
measured CLI/API-Gateway cases. No issue is closed on inferred evidence.
