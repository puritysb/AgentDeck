# Releasing & Versioning

AgentDeck is a monorepo of independently-shipped artifacts. Each ships on its **own version track** with a prefixed git tag. There is **no single repo-wide version** — Apple, Android, npm, and ESP32 advance separately.

> **Clean slate (2026-06-26):** all prior tags/releases were deleted and Apple/Android/ESP32 restarted at `0.1.x`. The Apple app moved to a **new bundle ID** (`bound.serendipity.agent.deck`) so App Store Connect starts fresh at `0.1.0 / build 1` — the old `bound.serendipity.agentdeck.dashboard` record carried an immovable build floor (build 8 / 1.0.6) that cannot be renumbered downward. **npm could not restart** — `0.1.0` already exists on the registry (immutable); its source version is cosmetic only (see the npm note below).

## Tracks

| Track | Source of truth | Tag prefix | CI workflow | Current |
|---|---|---|---|---|
| **Apple** (iOS+macOS) | `apple/project.yml` → `MARKETING_VERSION` + `CURRENT_PROJECT_VERSION` | `apple-v*` | `.github/workflows/apple-release.yml` → TestFlight | 0.1.0 / build 1 |
| **Android** | `android/app/build.gradle.kts` → `versionName` + `versionCode` | `android-v*` | `.github/workflows/android-release.yml` → APK Release | 0.1.0 / code 1 |
| **npm** (`@agentdeck/*`) | each `package.json` `version` (kept in lockstep) | `npm-v*` | manual `pnpm -r publish` | 0.1.0 source (registry latest 0.2.x — see note) |
| **ESP32** firmware | `esp32/src/config.h` → `FIRMWARE_VERSION` | `esp32-v*` | `.github/workflows/esp32-release.yml` | 0.1.1 |
| **Stream Deck** (Elgato Marketplace) | `plugin/bound.serendipity.agentdeck.sdPlugin/manifest.json` → `Version` (4-part `X.Y.Z.B`) | `streamdeck-v*` | manual: `pnpm package` → upload `.streamDeckPlugin` to Elgato Maker portal | 0.1.0.0 |
| **Ulanzi** (Ulanzi Studio Marketplace) | `plugin-ulanzi/com.ulanzi.ulanzistudio.agentdeck.ulanziPlugin/manifest.json` → `Version` | `ulanzi-v*` | manual: `pnpm --filter @agentdeck/plugin-ulanzi package` → upload the `.ulanziPlugin` folder | 0.1.0 |

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

### Android (APK + optional Google Play)
1. Bump `versionName` + `versionCode` in `android/app/build.gradle.kts`.
2. `git tag android-v<VERSION> && git push origin android-v<VERSION>` → CI builds + creates the GitHub Release with the signed APK.
3. Local build: `bash scripts/build-android-release.sh` → `dist/agentdeck-v<VERSION>.apk` (or `cd android && ./gradlew bundleRelease` for an `.aab`).

**Google Play (gated, off by default).** The `android-release.yml` workflow has an optional AAB-build + Play-upload step that is a **no-op until enabled**, so it never breaks the APK release. To turn it on:
1. Create the app in the Play Console (package `dev.agentdeck`) and upload the first AAB **manually once** (Play requires a manual first release before the API will accept uploads).
2. Create a Play service account (Google Cloud → Play Console → API access), grant release permissions, download its JSON key.
3. Add repo **secret** `PLAY_SERVICE_ACCOUNT_JSON` (the key JSON) and set repo **variable** `ANDROID_PLAY_ENABLED = true`.
4. From then on, pushing an `android-v<VERSION>` tag also builds `app-release.aab` and uploads it to the **internal** track (change `track:` in the workflow to promote). `versionCode` must keep increasing — Play rejects downgrades.

### npm (`@agentdeck/*`)
> **npm did NOT restart at 0.1.0.** `@agentdeck/shared`, `bridge`, and `setup` were *originally* published at 0.1.0, so those versions already exist and are immutable — registry `latest` is 0.2.x. The 2026-06-26 reset set the **source** `version` fields to 0.1.0 for cosmetic cross-track uniformity, but **nothing is published at 0.1.0 from the current code** and `pnpm publish` will skip/refuse it. Only these three packages are public (`private:false`); `plugin`, `plugin-ulanzi`, `hooks`, and the root are private.
>
> The next time you actually want to ship current code to npm, you **must bump forward past the highest published version** (≥ `0.2.3`) — npm can only go up. Publishing also requires a **2FA-enabled granular access token** (web login alone returns 403).

To publish a real release (forward version):
1. Bump `version` in every public workspace `package.json` to the next free version (≥ 0.2.3), in lockstep (internal deps use `workspace:*`, so no cross-pin edits needed).
2. `pnpm build` then `pnpm -r publish --access public` (needs a 2FA granular token in npm auth).
3. `git tag npm-v<VERSION> && git push origin npm-v<VERSION>`.

### ESP32 firmware
1. Bump `FIRMWARE_VERSION` in `esp32/src/config.h`.
2. `git tag esp32-v<VERSION> && git push origin esp32-v<VERSION>`.

### Stream Deck plugin (Elgato Marketplace)
1. Bump `Version` (4-part `X.Y.Z.B`, must **increase** for marketplace updates) in `plugin/.../manifest.json`. Optionally update the embedded `Version` in the bundled profile snapshots for consistency.
2. `pnpm package` → `dist/bound.serendipity.agentdeck.streamDeckPlugin`.
3. Upload via the Elgato Maker portal (Marketplace). The UUID `bound.serendipity.agentdeck` is **immutable post-distribution** — never change it.
4. `git tag streamdeck-v<VERSION> && git push origin streamdeck-v<VERSION>` (annotation only — no CI consumes it).

### Ulanzi plugin (Ulanzi Studio Marketplace)
1. Bump `Version` in `plugin-ulanzi/.../manifest.json`.
2. `pnpm --filter @agentdeck/plugin-ulanzi package` → `plugin-ulanzi/dist/com.ulanzi.ulanzistudio.agentdeck.ulanziPlugin/` (zip the folder for upload).
3. Upload via the Ulanzi Studio Marketplace portal.
4. `git tag ulanzi-v<VERSION> && git push origin ulanzi-v<VERSION>`.

## Marketplace plugins are thin clients — the daemon is a separate install

The Stream Deck and Ulanzi plugins are **WebSocket clients of the AgentDeck daemon** (port 9120); they do **not** embed or spawn the daemon. The daemon is a singleton that installs Claude/Codex hooks and manages the user's coding sessions — it must be installed once per dev machine, via either:

- **Node CLI** — `npx @agentdeck/setup` (or `agentdeck daemon start`), or
- **macOS app** — the App Store build runs an in-process Swift daemon.

Do not bundle the daemon into a marketplace plugin: it would collide with the existing daemon on port 9120 (singleton / split-brain) and silently edit the user's shell config from a plugin install. Instead:

- **Marketplace listing** must state the prerequisite ("Requires AgentDeck — install with `npx @agentdeck/setup` or the macOS app"), the way the OBS plugin requires OBS.
- **In-product onboarding**: when no daemon is reachable the plugin shows an OFFLINE state pointing the user to `npx @agentdeck/setup`. Stream Deck encoder strip: `shared/src/svg-renderers/session-slot-renderer.ts → renderOfflineTouchStrip`. Ulanzi/D200H OFFLINE hero: `shared/src/d200h-layout.ts` (center-key `renderInfoSlot` detail).

## After a bundle-ID change (Apple) — manual ASC steps

Code changes alone don't create the App Store presence. After merging a new bundle ID:

1. Register the new App ID in the Apple Developer portal.
2. Create the new app record in App Store Connect.
3. Generate a matching macOS/iOS provisioning profile; update `apple/ExportOptions*.plist` profile mappings if names change.
4. Refresh GitHub Secrets if the signing identity/profile changed (`APPLE_CERTIFICATE_*`, `ASC_*`).
5. The sandbox **data container path** changes with the bundle ID — existing installs start with a fresh container. All Node-side consumers that read the App Store container (`bridge/`, `hooks/`, `plugin/`, `plugin-ulanzi/`, `setup/`) are already pointed at the new path; keep them in sync on any future change.
