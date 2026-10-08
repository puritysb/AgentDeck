# AgentDeck App Store submission package

This directory contains prepared media and dated prior submission assets. Select
the appropriate release set before uploading.

## Screenshot sets

Localized screenshots live under `screenshots/{en,ko,ja}/{macOS,iPhone,iPad}/`.
The retained historical set contains five macOS images and four images per mobile
platform for each locale (39 images).
Raw source captures are under `screenshots-raw/`. Use only privacy-reviewed
captures of the actual app with synthetic sessions; never publish real workspace
names, conversations, desktop chrome or network addresses.

Do not upload from `apple/appstore-screenshots/`: it is a historical archive,
not the current submission package.

## 1.8.0 supplement selection

[Readiness and provenance](media-1.8.0-readiness.json) selects 12 new localized
screenshots: `06-hermes-fleet` and `07-github-ci` for iPad, plus
`06-native-attention` and `07-ci-context` for macOS, in English, Korean and Japanese.
The [contact sheet](screenshots-raw/1.8.0-supplement/contact-sheet.jpg) shows all 12.
The original 39 images remain unchanged.

The iPad images reuse approved fictional native simulator captures. Mac images
reuse prior actual native QA with four synthetic agents and no Hermes. The CI
frame shows UNKNOWN evidence; its exact capture commit was not retained. These
frames preserve current aquarium assets but do not demonstrate new settings
dialogs. Captions reflect these limits. New iPhone frames showed onboarding or
pairing and were rejected, so no new iPhone supplement is selected.

This supplement is prepared locally, not submitted. Play, Elgato and Ulanzi retain
dated listing media; current Android QA and rendered key previews remain
acceptance evidence. The manifest identifies remaining listing selection/review
work. Public showcase media is not an upload-ready Apple App Preview; the existing
preview files below retain their documented 1.5 provenance.

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
