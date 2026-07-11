# App Store Connect submission checklist

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
- [ ] Version: `0.2.3`, build `2` (increment the build number if build 2 has already been uploaded)
- [ ] macOS minimum: 26.0; iOS/iPadOS minimum: 17.0

## Product page

- [ ] Paste Korean and English fields from `docs/appstore-metadata-draft.md`
- [ ] Support URL: `https://github.com/puritysb/AgentDeck/issues`
- [ ] Marketing URL: `https://github.com/puritysb/AgentDeck`
- [ ] Privacy Policy URL: `https://puritysb.github.io/AgentDeck/#privacy`
- [ ] Upload only `apple/appstore-submission/screenshots/`
- [ ] Leave App Preview empty for the first release (optional)

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
- [ ] Paste `apple/APP_REVIEW_NOTES.md` into Review Notes
- [ ] State “No account required” in Sign-in information
- [ ] Attach no secrets, config files, or private logs
- [ ] Reviewer can open Device Preview without hardware or an agent session

## Build and release gate

- [ ] Complete `docs/testflight-qa-checklist.md` on one Mac, one iPhone, and one iPad
- [ ] Run `bash apple/scripts/validate-appstore-submission.sh --network`
- [ ] Build the Release archive
- [ ] Run `bash apple/scripts/verify-appstore-archive.sh <path-to-AgentDeck.app>` on the Release app
- [ ] Confirm `PrivacyInfo.xcprivacy` is embedded and declares the same two collected data types as App Store Connect, with tracking disabled
- [ ] Upload and wait for processing; select the correct build for both platform versions
- [ ] Recheck export compliance, content rights, age rating, and App Privacy before “Add for Review”
- [ ] Choose release method: manual release is recommended for v0.2.3

## Known blocker audit

- [ ] No screenshot exposes an auth token, project/repository name, IP address, home path, USB path, Terminal, Xcode, or browser chrome
- [ ] Metadata consistently says 17 Swift-standalone display previews
- [ ] Product description and screenshots claim only built-in Swift-daemon behavior; no developer-daemon-only feature appears
- [ ] Claims about on-device speech and Foundation Models match the submitted binary
- [ ] Support and privacy URLs are publicly reachable without login
- [ ] App Review notes still match the current archive and feature matrix
