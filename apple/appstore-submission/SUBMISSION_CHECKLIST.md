# App Store Connect submission checklist

> **Release status (2026-08-05):** macOS 1.0.2 (3901) is live. The first iPhone/iPad 1.0.2 submission (3901) was rejected on 2026-08-04 under Guideline 2.1(a) because the no-Mac screen kept animating after discovery completed. The replacement build must carry the terminal no-Mac state, offline Device Preview, iPad-specific Review Notes, and a higher CI-owned build number.

## App record

- [ ] App name: `AgentDeck Dashboard`
- [ ] Bundle ID: `bound.serendipity.agent.deck`
- [x] SKU: `agentdeck-dashboard-macos` (immutable existing app record)
- [x] Primary language: English (U.S.) (immutable existing app record)
- [ ] Additional localization: Korean
- [ ] Primary category: Developer Tools
- [ ] Secondary category: Productivity
- [ ] Price: Free
- [ ] Copyright: `© 2026 Serendipity Bound`
- [ ] Version: `1.0.2` — build number is CI-owned (`github.run_number` injected by `apple-release.yml`); never set it by hand (RELEASING.md)
- [ ] macOS minimum: 26.0; iOS/iPadOS minimum: 17.0

## Product page

- [ ] Paste Korean and English fields from `docs/appstore-metadata-draft.md`
- [ ] Support URL: `https://github.com/puritysb/AgentDeck/issues`
- [ ] Marketing URL: `https://github.com/puritysb/AgentDeck`
- [ ] Privacy Policy URL: `https://puritysb.github.io/AgentDeck/#privacy`
- [ ] Upload only `apple/appstore-submission/screenshots/`
- [x] Prepare one privacy-safe App Preview per platform under `apple/appstore-submission/previews/`
- [ ] Upload the selected App Previews and verify each 5-second poster frame after processing

## Compliance answers

- [ ] App Privacy: **Yes** — optional Anthropic API backend only
- [ ] Other User Content — linked to user, App Functionality, not tracking
- [ ] Product Interaction — linked to user, App Functionality, not tracking
- [ ] Tracking: No
- [ ] Advertising/marketing use: None
- [ ] Privacy policy URL entered for both iOS and macOS
- [ ] Export compliance: app uses only exempt/system-standard encryption; both Info.plists set `ITSAppUsesNonExemptEncryption = false`
- [ ] Advertising identifier: No
- [ ] Sign-in required: No
- [ ] Demo account: Not required
- [ ] Age rating questionnaire: no violence, sexual content, gambling, unrestricted web access, or user-generated content (expected rating 4+)
- [ ] Content rights: the app displays third-party product names/marks; confirm the attribution and right-to-display answer with the Account Holder before selecting the final App Store Connect response
- [ ] Digital Services Act trader status completed at the account level
- [ ] Korea/Vietnam/China availability questions reviewed for the intended storefronts

## Review information

- [ ] Contact name, phone, and email entered in App Review Information
- [ ] Paste the **iOS / iPadOS Notes field** block from `apple/APP_REVIEW_NOTES.md` into the iOS Review Notes
- [ ] Replace `[BUILD]` in the Guideline 2.1(a) Resolution Center reply with the selected replacement build number, then send it with the new submission
- [ ] State “No account required” in Sign-in information
- [ ] Attach no secrets, config files, or private logs
- [ ] On a clean iPad with no Mac present, the spinner stops after ~10 seconds and the reviewer can open **Explore without a Mac** without hardware or an agent session

## Build and release gate

- [ ] Complete `docs/testflight-qa-checklist.md` on one Mac, one iPhone, and one iPad
- [ ] Complete Section B first on a clean iPad while no AgentDeck Mac is present; capture the stable no-Mac screen and offline Device Preview as review evidence
- [ ] Run `bash apple/scripts/validate-appstore-submission.sh --network`
- [ ] Build the Release archive
- [ ] Run `bash apple/scripts/verify-appstore-archive.sh <path-to-AgentDeck.app>` on the Release app
- [ ] Confirm `PrivacyInfo.xcprivacy` is embedded and declares the same two collected data types as App Store Connect, with tracking disabled
- [ ] Upload and wait for processing; select the correct build for both platform versions
- [ ] Recheck export compliance, content rights, age rating, and App Privacy before “Add for Review”
- [ ] Choose release method: manual release is recommended for the 1.0.2 update
- [ ] Paste the **What's New (v1.0.2, macOS)** copy from `docs/appstore-metadata-draft.md` (ko/ja/en) into the version's release-notes field

## Known blocker audit

- [ ] No screenshot exposes an auth token, project/repository name, IP address, home path, USB path, Terminal, Xcode, or browser chrome
- [ ] No App Preview exposes an auth token, real project/repository name, IP address, home path, USB path, Terminal, Xcode, browser chrome, or system permission dialog
- [ ] Metadata consistently says 17 Swift-standalone display previews
- [ ] Product description and screenshots claim only built-in Swift-daemon behavior; no developer-daemon-only feature appears
- [ ] Claims about on-device speech and Foundation Models match the submitted binary
- [ ] Support and privacy URLs are publicly reachable without login
- [ ] App Review notes still match the current archive and feature matrix
