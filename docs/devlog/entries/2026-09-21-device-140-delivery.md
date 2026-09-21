# 2026-09-21 — Device and npm 1.4.0 delivery

Release preparation [PR #356](https://github.com/puritysb/AgentDeck/pull/356)
merged at `1c1f51b79027da112c425511cf12db80aee74ded`. Apple 1.4.0 (7001)
remains in its existing per-platform review submissions. No replacement Apple
store build was uploaded.

## Verified preparation

- Build/typecheck and 4,659 Vitest tests passed (2 skipped). The runtime welcome
  fixture was synchronized with the npm version. Protocol regeneration did not
  drift. Documentation/catalog and all token mirrors passed; clean-source
  design lint stayed at 89 existing violations.
- All ten PR CI checks passed, including Windows Node 22/24/26, native Apple,
  Android and ESP32 simulator checks.
- Android 1.4.0 (18): signed APK and AAB built; 395 JUnit tests passed. Lenovo
  HVA095B4 upgraded in place. GitHub APK release run `35548114194` succeeded.
- Stream Deck package validation passed; the exact CI artifact from
  `35548111974` was submitted. Maker Console reports Pending review 1.4 with
  automatic publication off. See [listing receipt](marketplace/elgato/LISTING.md).
- Native-free Ulanzi package and archive verification passed. Existing 1.3.0
  review record was inspected: Edit review work explicitly updates that record.
  No replacement has yet been saved. The prior file hash is
  `7ae4e162ad2441890dd6c84d758020c4.zip`.
- All 12 PlatformIO board builds passed locally. TRMNL 7.5 WiFi OTA succeeded
  through the Swift daemon using inline firmware fallback; the board reported
  version 1.4.0 afterwards. Firmware release run `35548784072` failed before compilation: moving
  pioarduino `stable` now requires Core >=6.2.0, incompatible with pinned Core
  6.1.19. The platform URL is pinned to upstream 55.03.311,
  whose published manifest requires >=6.1.19 and which passed the prior
  production release run `34753627616`. Local caches had used 55.03.37, so
  those local builds are not evidence for the newly pinned production toolchain. No firmware assets were published by the failed run. A fresh local 86 Box
  build using the published 55.03.311 archive passed in 191 seconds.

USB verification: the PlatformIO helper failed mid-write on 86 Box while the
old macOS app still held its port. The release CLI correctly refused recovery
until that unresponsive app was terminated (the supported stop did not free
its port). Then the CLI wrote a locally merged image at 115200 baud, verified
MD5, reset the board and read back `86box 1.4.0 (1c1f51b7)`. No erase was used.

## npm pre-tag verification in progress

All four 1.4.0 tarballs were installed through the actual Homebrew command path.
The former CLI symlink targeted the shared source checkout; only that symlink
was removed before npm installation, preserving the checkout. SQLite diagnostic
passes under Node 26.5.0. Rollback is the four published 1.3.5 packages plus the
supported daemon start command.

A real direct Codex turn completed through Node and was visible on the Lenovo
and Mac dashboards. Node alone owned 9120 in coexistence. After the supported
Node stop, the installed local macOS 1.3.2 build 4 ran on 9121 and eventually
reclaimed 9120; downstream delivery of the subsequent Swift turn was not
verified. This is not a completed three-mode soak or store-build coverage.
The App Store still recognizes the local development app as installed;
reinstallation via mas requires administrator authentication. A local Release
build from Apple 1.4.0 source passed; its development signing/build 4 is not
the submitted store build 7001. Further runtime verification remains pending.

Mac locking interrupted browser/native UI control. Ulanzi review replacement,
Google Play submission and remaining visual checks must resume after unlock.
The CLI candidate daemon was restarted after USB recovery and serves 9120
with build `f41092ed2b91`; the old macOS app is closed. No npm tag has been pushed. This entry records partial delivery, not completion
of the whole release round.
