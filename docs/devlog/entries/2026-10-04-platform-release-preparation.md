# 2026-10-04 — Apple submission and other platform release preparation

## Apple submission receipt

The owner renewed the Apple login and authorized completing submission.
App Store Connect accepted **1.7.0 (7701)** on both platforms, separately:

- iOS: **Waiting for Review**, 2026-10-04 08:53 KST, submission
  [5b10c47f-27e9-4e85-8272-4cca25eb6c13](https://appstoreconnect.apple.com/apps/6784822497/distribution/reviewsubmissions/details/5b10c47f-27e9-4e85-8272-4cca25eb6c13).
- macOS: **Waiting for Review**, 2026-10-04 08:54 KST, submission
  [dbbf2649-9aae-414a-a727-02f73e863891](https://appstoreconnect.apple.com/apps/6784822497/distribution/reviewsubmissions/details/dbbf2649-9aae-414a-a727-02f73e863891).

Both use the replacement build from source `65847d64` and release run
[37096769559](https://github.com/puritysb/AgentDeck/actions/runs/37096769559).
This supersedes the draft-only state in the
[October 3 receipt](docs/devlog/entries/2026-10-03-apple-release-lifecycle-acceptance.md).
The submission bundle validator passed again. Existing previews and screenshots
remain representative of supported app views; English/Korean/Japanese release
notes describe 1.7.0. Physical iPad/iPhone acceptance remains unmeasured.
Submission is not public release; Apple 1.6.0 remains the last measured live version.

## Other channels

Preparing npm, Android (versionCode 24), ESP32, Stream Deck and Ulanzi 1.7.0
from the accumulated Hermes, usage and lifecycle improvements. Stream Deck
provider persistence PR #440 passed review and CI and merged as `2518733b`.
Ulanzi #445 gains bounded loopback health discovery without cross-OS PID checks.
Tests cover absent/stale/invalid registries, unhealthy/unauthorized/oversized
responses, silence, registration and stopping during an in-flight discovery.
Windows + WSL2 physical-device acceptance is not implied by these local tests.
No new channel tag or public-delivery claim is made by this preparation record.
