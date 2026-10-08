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

## Release delivery evidence

PR [#443](https://github.com/puritysb/AgentDeck/pull/443) merged as
`65847d64e483fa3b494e35e08a3ee9de5d91c0dc`, after all nine PR checks passed.
The corrected Apple 1.7.0 candidate was built from that exact commit in
[release run 37096769559](https://github.com/puritysb/AgentDeck/actions/runs/37096769559).
Both exported artifacts passed App Store archive verification and both upload
steps reported `UPLOAD SUCCEEDED with no errors`. The old `apple-v1.7.0` tag
was preserved; this replacement used a pinned manual workflow ref.
App Store Connect independently showed build 7701 on both platforms.
Both builds finished processing, were saved on their 1.7.0 version records,
and were added to review drafts after portal validation. The final
Submit for Review action has not been performed; neither draft is submitted.

Local verification before merge: 5,094 Vitest tests, 1,007 macOS tests, ten
real-daemon E2E tests and 17 Python observer tests passed (the suites also
reported two intentional skips each in Vitest and macOS). Protocol generation
left no drift; documentation, design/token and submission-bundle gates passed.

The iPad Air M2 simulator (iPadOS 18.6) rendered the actual app aquarium against
a synthetic loopback feed, including the bundled Hermes face, working cue,
roster and timeline. Local capture:
`diagnostics/release-acceptance/hermes-ipad-simulator.png`. This does not stand
in for physical-device acceptance. Physical iPad Air and iPhone 14 Pro Max
remained unavailable, and the owner’s visual acceptance is still pending.
The owned simulator and temporary feed were stopped after capture. Broader
#426 child/messaging-platform cases remain separate from the measured CLI/API
Gateway cases. No issue is closed on inferred evidence.
