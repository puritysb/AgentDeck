# AgentDeck App Store submission package

This directory contains the assets that are safe to upload to App Store Connect.

## Screenshot sets

Localized screenshots live under `screenshots/{en,ko,ja}/{macOS,iPhone,iPad}/`.
The current set contains five macOS images and four images per mobile platform.
Raw source captures are under `screenshots-raw/`. Use only privacy-reviewed
captures of the actual app with synthetic sessions; never publish real workspace
names, conversations, desktop chrome or network addresses.

Do not upload from `apple/appstore-screenshots/`: it is a historical archive,
not the current submission package.

## App Preview videos

The upload files are `previews/<platform>/agentdeck-preview.mp4` for
`macOS`, `iPhone` and `iPad`. The macOS cut includes the aquarium, Collaboration
and Dashboard settings. The mobile cuts were recaptured on 2026-09-23 from
the current 1.5.0 Apple source and show the 3D aquarium, growing session roster,
attention request and completion. Each mobile cut is 25 seconds. These English
UI recordings are the canonical videos for all storefront languages; localized
screenshots and metadata remain available. See the delivery record for actual
portal upload and submission status.

Use 1920×1080 for Mac, 886×1920 for iPhone and 1200×1600 for portrait iPad.
Previews must be 15–30 seconds, H.264 High Profile Level 4.0, progressive,
30 fps, with a silent AAC track. Validate each final file before upload.
Keep original recordings locally for provenance.

## 1.5.0 delivery

See [current Apple delivery record](macos-1.5.0.md). Localized update text is
in [macOS metadata](macos-1.5.0-metadata.json) and
[iOS metadata](ios-1.5.0-metadata.json). English is canonical; Korean and
Japanese are translations. Preserve existing dashboard choices and identify
3D as an optional preview. Apple update text must describe the Apple app only.

## 1.5.1 preparation — publication on hold

The owner requested preparation only on September 24; do not upload, submit,
publish or create release tags until a later release instruction. Draft PR #378
contains the proposed version mirrors and Dashboard working-row improvement.
Copy-ready localized text is in [macOS 1.5.1 metadata](macos-1.5.1-metadata.json)
and [iOS 1.5.1 metadata](ios-1.5.1-metadata.json). These files have not been sent
to App Store Connect. Preserve the existing macOS 1.5.0 review.

[Signed CI run 35966139745](https://github.com/puritysb/AgentDeck/actions/runs/35966139745)
archived and exported both platforms at **1.5.1 (7401)** from `5c8b6445`.
Both exported applications passed the App Store verifier. `upload=false` kept
TestFlight/App Store Connect delivery disabled; artifacts exist only in CI.
The nine PR checks also passed. Further iOS device installation and verification
are waived for this round by the owner; this does not waive automated checks.

Before a future release:

- Reassess the final scope and version numbers if more improvements land.
- Rebuild signed artifacts if Apple executable/build inputs change; the existing
  receipt covers only its recorded source commit.
- The installed three-mode daemon acceptance passed for candidate `1a40fe5c`;
  see the [measured receipt](../../docs/devlog/entries/2026-09-24-candidate-daemon-acceptance.md).
  Repeat relevant acceptance if executable inputs change before the final release.
  The original development daemon, app and Stream Deck runtime were restored.
- Finish the Elgato processed-package physical encoder gate in #349 when the owner
  can operate the device; retain the latest development plugin in the meantime.
- Refresh per-platform store state; Ulanzi requires renewed sign-in. External
  review/reporter waits are not evidence of an incomplete local implementation.
- Update the candidate-only CHANGELOG wording and actual release date at release
  time, then independently verify upload, submission and public availability.

## Metadata and review material

- Copy-ready Korean and English fields: `docs/appstore-metadata-draft.md`
- Reviewer notes: `apple/APP_REVIEW_NOTES.md`
- Privacy manifest: `apple/AgentDeck/Resources/PrivacyInfo.xcprivacy`
- Feature boundary: `docs/appstore-feature-matrix.md`
- TestFlight QA: `docs/testflight-qa-checklist.md`
- Submission decisions and remaining manual steps: `apple/appstore-submission/SUBMISSION_CHECKLIST.md`
- App Preview capture record and poster-frame guidance: `apple/appstore-submission/APP_PREVIEW_STORYBOARD.md`
- Repeatable launch storyline and synchronized terminal rehearsal: `apple/appstore-submission/RECORDING_RUNBOOK.md`

Run validation before every upload:

```bash
bash apple/scripts/validate-appstore-submission.sh
```

For privacy-safe dashboard captures, run `node scripts/appstore-screenshot-mock.mjs`,
set the Simulator app preference `prefs.hasSeenOnboarding` to `YES`, then launch
a Debug Simulator build with `-AgentDeckScreenshotURL ws://127.0.0.1:9220/dashboard`
or `/attention`.
The Debug-only launch argument bypasses mDNS so a developer daemon cannot leak
real session data into the images. Neither the helper nor the launch path is
included in Release/App Store builds.

Add `--network` to verify the public URLs as well.

App Preview videos remain optional in App Store Connect, but upload-ready files are now provided for all three platforms. App previews appear before screenshots, so verify the 5-second poster frame after upload. Never include Terminal, Xcode, browser chrome, secrets, real project names, or local network addresses.
