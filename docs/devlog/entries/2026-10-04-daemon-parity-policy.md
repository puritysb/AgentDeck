# 2026-10-04 — Shared Kiro state and daemon takeover policies

## Change

The Node Kiro projection previously changed `processing` to `idle` after ten
minutes of silence, while native Swift retained explicit turn state. Node now
retains that state for a surviving process. Native v3 text records cannot reopen
an ended turn. Legacy prompt/tool/final-assistant state decisions are also
shared, including native Swift's previously missing tool-use state handling.
File-only discovery expiry remains separate from turn completion; Swift's
permission-bound file census and Node's live-process census are different
observation sources.

[shared/src/daemon-parity.ts](shared/src/daemon-parity.ts) owns boundary tables,
runtime acceptance and handover timing. The generated Swift mirror and common
JSON vectors are drift-gated; vectors execute through both TS and Swift locally.
The [architecture catalogue](docs/architecture.md#cross-platform-ssot-catalogue)
records the generation path.

Swift's former 45-second lease could expire before Node's 90-second macOS bind
retry. Its lease now derives from the shared 12-second exit wait, 30-second bind
wait, 90-second reclaim and 15-second startup margin (147 seconds). Every
promotion respects the lease and schedules bounded recovery if Node never
arrives. During takeover, Swift follows a registry fallback port and rejects an
explicit Swift response as the requested Node owner. CLI start/restart readiness
also rejects Swift, with a specific failure rather than false success. Legacy
missing runtime identity remains unknown/permissive.

## Verification

- Build and typecheck passed. The final full TS run passed 5,123 tests with two
  skipped. Generated protocol files have no diff. Common policy tests execute
  generated Swift.
- macOS targeted XCTest: 33 passed, one existing test skipped, zero failures.
- Real-process E2E on macOS (explicit opt-in): all 10 passed.
- Signed development app PID 24017 owned 9120 (`isSwift: true`). Foreground Node
  from this checkout requested stand-down at 21:54:59 KST and owned 9120 at
  21:56:01 (`isSwift: false`, PID 24166, build `0887cb37836c`). The same Swift
  app process remained alive. Supported Node stop then allowed Swift to recover
  canonical 9120 automatically, after its existing fallback/reclaim interval.
  Original global npm 1.7.0 and TestFlight 7701 execution was restored afterward.
- Docs, design catalogue, generated policy drift and token mirrors passed.
  Raw design lint retains the baseline 92 violations; no colour/style changes.
- Release archive built with development signing. The App Store verifier passed
  its code/entitlement checks but correctly rejected development signing. A
  distribution archive attempt failed because this Mac lacks the organization
  QF36NDHYHD Mac App Distribution identity's private key. The local distribution
  identity belongs to another team and cannot substitute for it.

## Delivery boundary

This is a source fix for issues [#411](https://github.com/puritysb/AgentDeck/issues/411)
and [#449](https://github.com/puritysb/AgentDeck/issues/449), not a replacement of
App Store 1.7.0(7701) or npm 1.7.0. Existing store review submissions remain
unchanged; a future Apple delivery must pass distribution archive verification.
