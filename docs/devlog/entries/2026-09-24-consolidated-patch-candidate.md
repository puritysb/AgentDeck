# 2026-09-24 — Consolidated npm and Apple patch candidate

Prepared npm **1.4.3** and Apple **1.5.1** together from upstream `d2e4d439`,
keeping the local IPS10 personal-voice development branch outside this release.
The owner now requests preparation only: no immediate release, upload, submission
or release tags. A future release requires a later instruction. This
entry records candidate preparation, not publication, upload or submission.

## Scope

- npm carries the preferred-port startup retry fix from PR #374 / issue #370.
- Apple carries the working-agent Dashboard row emphasis from PR #376.
- Stream Deck development installation/runtime verification is already merged
  in PR #377. It does not by itself replace the approved Marketplace binary.
- ESP32 firmware delivery remains deferred; no new firmware was flashed.

## Validation

Build and typecheck passed. Vitest: **4,696 passed, two skipped**. Protocol
generation left no drift; version, Markdown, design catalog and seven token
mirror checks passed. Design lint reports the existing 89 source violations
plus three generated Ulanzi bundle findings in this built checkout.

The local iOS development build is signed and reports 1.5.1. The owner explicitly
waived further iOS device installation and verification for this round. Before
that instruction, installation on the connected iPad completed; the iPhone XR
attempt timed out without a confirmed installation. These are not a completed
iOS device acceptance pass. No further iOS device checks are required this round.

The local unsigned macOS Release archive compiled, but the App Store verifier
correctly rejected its missing signed sandbox entitlement. This is not a signed
distribution acceptance pass. The subsequent
[CI manual-signing run 35966139745](https://github.com/puritysb/AgentDeck/actions/runs/35966139745)
passed for both exported platforms at 1.5.1 (7401), source `5c8b6445`, with upload
disabled. All nine PR checks passed. This supersedes the unsigned local archive
limitation for that source; no App Store delivery occurred. Prepared English,
Korean and Japanese patch metadata for later use without changing the 1.5.0
submission records.

## Delivery holds

- Candidate `1a40fe5c` passed the installed CLI-only, Swift-only and coexistence/
  recovery gate; see the [acceptance receipt](docs/devlog/entries/2026-09-24-candidate-daemon-acceptance.md).
  Revalidate relevant acceptance if executable inputs change before release.
  Earlier #370 A/B evidence is retained separately.
- Official Elgato 1.4 processed-package physical encoder verification remains
  open in #349. Keep the verified development plugin installed until the owner
  is available for physical rotation, press and touch interactions; restore and
  verify that development runtime after the Marketplace test.
- ASC read-only run [35965282565](https://github.com/puritysb/AgentDeck/actions/runs/35965282565)
  confirms iOS 1.5.0 `READY_FOR_SALE` and macOS 1.5.0 `IN_REVIEW` independently.
  Preserve the existing macOS review; do not replace its build.
- Ulanzi 1.4.0 was last observed under review on September 24. A later refresh
  redirected to login, so a newer private review state is unverified.
- #303 and #367 await external Windows evidence; #272, #273 and #348 remain
  separately scoped research/migration/consumer-dependent work.

No release tag, registry publication, App Store upload or replacement submission
was performed while preparing this candidate.
