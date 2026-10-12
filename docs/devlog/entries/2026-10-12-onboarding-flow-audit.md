# 2026-10-12 — Store onboarding flow audit and companion recovery

The macOS guide was exercised through appearance, agents, readiness, Settings
re-entry and Device Preview on the installed 1.9.0 development app. Android's
1.9.0 release captures for Lenovo and Crema and its persistence/connection code
were reviewed; this audit does not claim a fresh Android physical-device pass.

A clean iPhone SE (375 × 667, iOS 18.6 simulator) reproduced clipped connection
instructions in the submitted onboarding source. Its fixed header competed with
a second, branded, scrolling connection overlay. The guide now scrolls its full
instructions and compact connection card together, with Back / Dashboard / Explore
kept outside the scroll. Live connections survive Back and preview navigation.
The settings re-entry button, previously macOS-only, is also available on iOS.

Camera authorization is refreshed when returning to the presented QR scanner;
the connection step now shares the dashboard's foreground/background recovery
when returning from Local Network settings. These lifecycle corrections are
source-verified; real-camera QR and a signed-device permission denial/grant cycle
remain physical-device checks rather than simulator claims.

Following the guide into Settings exposed another misleading path: the companion
said to enable hooks below or select Mac folders, although those controls do not
exist on iOS. Companion integration status now uses received host data and live
sessions, reports absent data neutrally, and sends setup questions to the Mac.
Local companion preferences are not evidence of the host's consent/configuration.

The simulator pass exercised first launch, discovery, approval-required status,
unreachable manual URL with the keyboard open, Back, offline Device Preview,
return to setup, dashboard entry without a host, and Settings re-entry. Layout
XCTest covers phone portrait, landscape, accessibility text and iPad dimensions,
with screenshots attached to xcresult. CI now executes those iOS tests rather
than merely building the app. Enabling execution exposed five existing test files
with macOS-only symbols outside platform guards; the guards preserve their macOS
coverage while allowing the companion test target to compile.

The [TestFlight checklist](docs/testflight-qa-checklist.md) now describes the
current guide, explicit notification consent, recovery, and the limits of
simulator evidence. These fixes are subsequent source changes, **not part of
submitted Apple 1.9.0 build 7901**. No Store submission was replaced by this audit.

## Validation

`pnpm verify:changed` passes all 13 selected gates, including Store Release and
DotPreview builds on both Apple targets. macOS Debug executes 1,143 tests and
optimized DotPreview executes 1,164 (4 / 8 existing skips, zero failures).
The separate iOS simulator run executes 18 onboarding, integration, preference,
connection-phase and bounded-search tests with zero failures. The final iOS build
was also reopened to confirm the corrected companion guidance and Settings
re-entry, then the audit-only simulator was shut down.

The quick run passes 5,818 TypeScript tests and its other selected checks after
adding the catalog's Korean copy. Its token read overlapped the changed-tier
self-test's intentional `--bogus` mutation and reported transient drift. The
same seven mirror files and checker, copied byte-for-byte to a temporary directory,
pass both normal verification and all 14 mutation self-tests in isolation; the
changed-tier token gate also passes. This was verifier interference, not a token
source change. The opt-in Keychain E2E was not rerun for these native UI changes.
