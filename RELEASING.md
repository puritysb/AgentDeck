# Releasing & Versioning

AgentDeck uses one product version across every maintained surface. The canonical value is the root [`VERSION`](VERSION) file; package manifests and platform project files mirror it because their build and distribution tools require native version fields.

The current product version is **0.2.3**. This is the first unified release train after the 2026-06-26 reset exposed a registry mismatch: Apple could legitimately restart under a new bundle ID, but the existing npm package identities could not reuse or lower already-published versions. `0.2.3` is the first version above every published npm package and is therefore the common convergence point.

Run `pnpm verify-version` before every build or release. CI rejects drift between `VERSION` and its mirrors.

## Unified version, independent delivery

| Surface | Product-version mirror | Independent monotonic value | Tag / delivery |
|---|---|---|---|
| **Apple** (iOS+macOS) | `apple/project.yml` `MARKETING_VERSION` | `CURRENT_PROJECT_VERSION` (currently 2) | `apple-v*` → TestFlight |
| **Android** | `android/app/build.gradle.kts` `versionName` | `versionCode` (currently 2) | `android-v*` → APK Release / optional Play |
| **npm** (`@agentdeck/shared`, `bridge`, `setup`) | public `package.json` files | npm registry version floor | `npm-v*` → manual publish |
| **ESP32** | `esp32/src/config.h` `FIRMWARE_VERSION` | build hash / epoch in firmware metadata | `esp32-v*` → firmware Release |
| **Stream Deck** | plugin manifest `Version` as `X.Y.Z.0` | fourth component if a same-product-version plugin rebuild is ever required | `streamdeck-v*` → Elgato Maker portal |
| **Ulanzi** | Ulanzi manifest `Version` | marketplace submission record | `ulanzi-v*` → Ulanzi Studio Marketplace |
| **Private JS workspaces** | their `package.json` files | not published | no independent delivery |

Tag prefixes remain because channels ship independently and may point to different commits. A product version bump updates every source mirror, but a channel is considered shipped only when its prefixed tag and external release/submission exist. Do not claim an unsubmitted marketplace artifact as released merely because its source manifest is synchronized.

## Version rules

1. Bump the root `VERSION`, then update every mirror in the same commit. `pnpm verify-version` is the enforcement mechanism.
2. Never reuse, delete-and-recreate, or lower a version that reached an external registry/store. Git tags do not reset external version floors.
3. Apple build number and Android versionCode always increase, even when the marketing/product version jumps.
4. Public npm packages stay in lockstep and publish in dependency order: `shared` → `bridge` → `setup`.
5. A platform-only hotfix still advances the common product patch version. Unchanged channels may skip binary publication, but their source mirrors move with the repository.
6. Keep prefixed tags; there is no unprefixed repo-wide release tag.
7. The only valid version reset is a genuinely new external identity (for example a new Apple bundle ID or npm package name). Document that migration before changing source versions.

## Hard external constraints

- **Apple / App Store Connect**: `CFBundleVersion` must increase. A lower marketing/build sequence is only possible with a new bundle ID and ASC record.
- **Android**: `versionCode` must increase for in-place upgrades and Play submission.
- **npm**: published versions are immutable. At convergence, registry floors were shared `0.2.0`, bridge `0.2.2`, setup `0.2.0`, so the unified train begins at `0.2.3`.
- **Marketplaces**: plugin identifiers are immutable after distribution; only their versions advance.

## Preparing a product-version bump

1. Choose the next SemVer greater than all external floors and update `VERSION`.
2. Update all mirrors checked by `scripts/verify-version-sync.mjs`.
3. Increment Apple `CURRENT_PROJECT_VERSION` and Android `versionCode`.
4. Update user-facing release notes and the delivery table in `README.md`.
5. Run `pnpm verify-version`, `pnpm build`, and the relevant platform workflows.
6. Commit the synchronized release state. Create only the channel tags that are actually being delivered.

## Channel release steps

### npm (`@agentdeck/*`)

Only `shared`, `bridge`, and `setup` are public; root, hooks, plugin, and plugin-ulanzi are private. npm publishing requires a 2FA-enabled granular token.

1. Verify all public manifests match `VERSION` and that the version is unused on npm.
2. Run `pnpm build` and tests.
3. Publish in dependency order with `pnpm --filter @agentdeck/shared publish --access public`, then bridge, then setup.
4. Confirm each package's `latest` dist-tag matches `VERSION`.
5. Tag the exact published commit: `git tag npm-v<VERSION> && git push origin npm-v<VERSION>`.

### Apple (TestFlight / App Store)

1. Confirm `MARKETING_VERSION == VERSION` and increment `CURRENT_PROJECT_VERSION` in both `apple/project.yml` and the Xcode project mirror.
2. Run the Release build and App Store archive verifier described in `CLAUDE.md`.
3. Tag and push `apple-v<VERSION>`; CI archives and uploads to TestFlight.

### Android (APK / optional Play)

1. Confirm `versionName == VERSION` and increment `versionCode`.
2. Follow `.agents/workflows/build-android.md` for the signed release APK.
3. Tag and push `android-v<VERSION>` to create the GitHub Release. Optional Play upload remains gated by `ANDROID_PLAY_ENABLED` and its service-account secret.

### ESP32 firmware

1. Confirm `FIRMWARE_VERSION == VERSION` and run the relevant PlatformIO/hardware verification.
2. Tag and push `esp32-v<VERSION>`.

### Stream Deck plugin

1. Confirm the main manifest and embedded profile snapshots use `VERSION.0`.
2. Follow `.agents/workflows/build-plugin.md`, then run `pnpm package`.
3. Upload to the Elgato Maker portal and tag `streamdeck-v<VERSION>` when actually submitted/released.

### Ulanzi plugin

1. Confirm both Ulanzi package and marketplace manifests match `VERSION`.
2. Run `pnpm --filter @agentdeck/plugin-ulanzi package`, upload the artifact, and tag `ulanzi-v<VERSION>` when actually submitted/released.

## Marketplace plugins are thin clients

Stream Deck and Ulanzi plugins connect to the AgentDeck daemon on port 9120; they do not embed or spawn it. Marketplace listings must state that AgentDeck must be available through `npx @agentdeck/setup` or the macOS app. Do not bundle the daemon into a plugin or silently modify shell configuration from a marketplace install.

## Historical Apple identity change

The Apple app moved from the retired `bound.serendipity.agentdeck.dashboard` record to `bound.serendipity.agent.deck` in 2026-06. That new identity legitimately restarted App Store version/build numbering. It did not reset npm, Android installs, or any other existing external identity. Preserve this distinction in future migrations.
