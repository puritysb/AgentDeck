# Releasing & Versioning

AgentDeck is a monorepo of independently-shipped artifacts. Each ships on its **own version track** with a prefixed git tag. There is **no single repo-wide version** — Apple, Android, npm, and ESP32 advance separately.

> **Clean slate (2026-06-26):** all prior tags/releases were deleted and every track restarted at `0.1.x`. The Apple app moved to a **new bundle ID** (`bound.serendipity.agent.deck`) so App Store Connect starts fresh at `0.1.0 / build 1` — the old `bound.serendipity.agentdeck.dashboard` record carried an immovable build floor (build 8 / 1.0.6) that cannot be renumbered downward.

## Tracks

| Track | Source of truth | Tag prefix | CI workflow | Current |
|---|---|---|---|---|
| **Apple** (iOS+macOS) | `apple/project.yml` → `MARKETING_VERSION` + `CURRENT_PROJECT_VERSION` | `apple-v*` | `.github/workflows/apple-release.yml` → TestFlight | 0.1.0 / build 1 |
| **Android** | `android/app/build.gradle.kts` → `versionName` + `versionCode` | `android-v*` | `.github/workflows/android-release.yml` → APK Release | 0.1.0 / code 1 |
| **npm** (`@agentdeck/*`) | each `package.json` `version` (kept in lockstep) | `npm-v*` | manual `pnpm -r publish` | 0.1.0 |
| **ESP32** firmware | `esp32/src/config.h` → `FIRMWARE_VERSION` | `esp32-v*` | `.github/workflows/esp32-release.yml` | 0.1.1 |

## Hard constraints (why we can't just renumber)

External systems remember version floors even after git tags are deleted:

- **Apple / App Store Connect** — `CFBundleVersion` (build) must strictly increase per `CFBundleShortVersionString`, and a new App Store version must exceed the last released one. The *only* way to truly restart at a lower number is a **new bundle ID = new ASC app record**.
- **Android** — `versionCode` must strictly increase for in-place upgrades (`adb install -r` and Play both reject downgrades with `INSTALL_FAILED_VERSION_DOWNGRADE`). Lowering `versionCode` forces an **uninstall + reinstall** on every device.
- **npm** — a published `version` can never be re-published. `latest` follows the highest semver, so publishing a *lower* version after a higher one does **not** move `latest` without an explicit `npm dist-tag`.

Bump versions forward; never reuse or lower a number that has already shipped.

## Release steps

### Apple (TestFlight)
1. Bump `MARKETING_VERSION` (+ `CURRENT_PROJECT_VERSION` build) in `apple/project.yml`. If using xcodegen, also mirror into `apple/AgentDeck.xcodeproj/project.pbxproj` (or regenerate with `xcodegen` — note this rewrites shared schemes).
2. Commit, then `git tag apple-v<VERSION> && git push origin apple-v<VERSION>`.
3. CI archives on a macOS runner and uploads to TestFlight.
4. Local build: `bash scripts/build-apple-release.sh --all`.

### Android (APK)
1. Bump `versionName` + `versionCode` in `android/app/build.gradle.kts`.
2. `git tag android-v<VERSION> && git push origin android-v<VERSION>` → CI builds + creates the GitHub Release with the signed APK.
3. Local build: `bash scripts/build-android-release.sh` → `dist/agentdeck-v<VERSION>.apk`.

### npm (`@agentdeck/*`)
1. Bump `version` in every workspace `package.json` in lockstep (internal deps use `workspace:*`, so no cross-pin edits needed).
2. `pnpm build` then `pnpm -r publish --access public`.
3. `git tag npm-v<VERSION> && git push origin npm-v<VERSION>`.

### ESP32 firmware
1. Bump `FIRMWARE_VERSION` in `esp32/src/config.h`.
2. `git tag esp32-v<VERSION> && git push origin esp32-v<VERSION>`.

## After a bundle-ID change (Apple) — manual ASC steps

Code changes alone don't create the App Store presence. After merging a new bundle ID:

1. Register the new App ID in the Apple Developer portal.
2. Create the new app record in App Store Connect.
3. Generate a matching macOS/iOS provisioning profile; update `apple/ExportOptions*.plist` profile mappings if names change.
4. Refresh GitHub Secrets if the signing identity/profile changed (`APPLE_CERTIFICATE_*`, `ASC_*`).
5. The sandbox **data container path** changes with the bundle ID — existing installs start with a fresh container. All Node-side consumers that read the App Store container (`bridge/`, `hooks/`, `plugin/`, `plugin-ulanzi/`, `setup/`) are already pointed at the new path; keep them in sync on any future change.
