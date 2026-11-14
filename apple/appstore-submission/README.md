# AgentDeck App Store submission package

This directory contains prepared media and dated prior submission assets. Select
the appropriate release set before uploading.

## 2.0.0 selected submission set

[Selection and SHA-256 provenance](media-2.0.0-selection.json) identifies the 36
new English, Korean and Japanese screenshots (four per platform) selected for
2.0.0. [Localized descriptions and update text](metadata-2.0.0.json) accompany
the three preview videos. Other retained screenshot files are historical extras.
Prepared does not mean uploaded, submitted or live; record each portal readback.

## 2.2.0 iOS selected set: Remote monitoring and Apple Watch (prepared 2026-11-14)

[Selection and SHA-256 provenance](media-2.2.0-selection.json) pins, per locale,
five iPhone and five iPad screenshots (the 2.1.0 set plus `05-remote` in second
position), the unchanged 2.1.0 iPhone/iPad previews, and six Apple Watch
screenshots (`screenshots/en/Watch/ultra49-*.png`, 422×514, `APP_WATCH_ULTRA`;
the Watch UI is English-only, so all locales share them). The Watch app ships
inside the iPhone app, so its media belongs to the iOS version. `series46-*.png`
(416×496) are retained alternates. [Localized listing](metadata-2.2.0.json).
`previews/Watch/agentdeck-watch-demo-ultra49.mp4` is a demo for the web site
and review notes; App Store Connect has no App Preview slot for Apple Watch.

The listing copy below was folded into `metadata-2.2.0.json`; it is kept here
as the short form for the web site:

> **Apple Watch.** Glance at your agents from your wrist. The AgentDeck Watch
> app reads the encrypted summary your Mac shares to your private iCloud: how
> many agents need you, which are working, each agent's mark and state, and how
> much allowance is left. Complications keep the count on your watch face, and
> a forwarded alert shows who is waiting. It is read-only: answer on your Mac.

> **Apple Watch.** 손목에서 에이전트 상태를 확인하세요. AgentDeck Watch 앱은
> Mac이 개인 iCloud에 공유한 암호화된 요약을 읽어, 응답을 기다리는 에이전트
> 수, 작업 중인 에이전트, 에이전트별 마크와 상태, 남은 사용량을 보여 줍니다.
> 컴플리케이션으로 시계 화면에 개수를 두고, 전달된 알림에서 누가 기다리는지
> 볼 수 있습니다. 읽기 전용이며 응답은 Mac에서 합니다.

Before upload: Production CloudKit read and a forwarded long look on a
physical Watch, the two Watch App Store profiles and CI secrets
([setup](../../docs/asc-cert-setup.md)), a signed archive passing
`verify-appstore-archive.sh`, and a Watch-face complication capture from that
device (the simulator in this Xcode has no face editor).

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
work. Public showcase media is not an upload-ready Apple App Preview; historical
1.5 previews remain in git history; the current local 2.0 candidates are described below.

## App Preview videos

The local 2.0 candidate files are `previews/<platform>/agentdeck-preview.mp4`
for `macOS`, `iPhone` and `iPad`. Each is about 28 seconds and introduces multiple
sessions plus usage (mobile) or observed Collaboration Beta (Mac). Mobile previews then show a real local
question, original choice, one-time approval and resumed result. The Mac preview
uses only native overview, session context and Collaboration Beta; it does not
show Node-produced OpenCode response controls. These use actual
native app frames with fictional overview activity and a separately evidenced
real OpenCode execution. They are prepared locally, not uploaded or approved.
See the [current capture record](APP_PREVIEW_STORYBOARD.md) and
[media manifest](../../docs/media/current/manifest.json) for exact sources and cuts.

The broader Pages/README product introduction is a separate 2 min 24 sec tour;
it must not be used as a Store App Preview. Historical 1.5/1.8 delivery records
remain dated evidence and do not describe these new candidate files.

Current canvases are Mac 1920×1080, iPhone 886×1920 and landscape iPad 1600×1200.
Candidates use original-speed native frames, H.264 High Profile Level 4.0,
progressive 30 fps, CBR at 11 Mbps, and silent AAC-LC stereo at 44.1 kHz.
Validate each final file and recheck current Store requirements and submitted-build
parity during release preparation. Preserve originals locally for provenance.

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

App Preview videos remain optional in App Store Connect. Local development candidates are provided for all three platforms; they still require release and storefront review. App previews appear before screenshots, so verify the 5-second poster frame after upload. Never include Terminal, Xcode, browser chrome, secrets, real project names, or local network addresses.
