---
id: policy.releasing
title: Releasing and Versioning
description: Shared compatibility line, per-target patch versions, release tags, and monotonic constraints.
category: Engineering
locale: en
canonical: true
status: required
owner: Release maintainers
reviewed: 2026-08-06
revision: 2026-08-06
source_of_truth: RELEASING.md
validators: [node scripts/build-design-system-viewer.mjs --check, pnpm verify-version]
---

# Releasing & Versioning

AgentDeck uses one `major.minor` compatibility line across every maintained surface. Two numeric `X.Y.Z` product versions are mutually compatible if and only if their first two components match. Patch values are ignored in both directions: for example, `1.0.1` and `1.0.9` are compatible regardless of which side is newer.

Root [`VERSION`](VERSION) is the repository baseline and compatibility-line anchor, not a patch ceiling and not a runtime negotiation value. It currently reads **1.0.2**, so every maintained target must remain on compatibility line **1.0**. npm/CLI is at `1.0.6`; Stream Deck and Android are at `1.0.4`; Apple is at `1.0.3`; ESP32 is at `1.0.2`; Ulanzi is at `1.0.2`. A target may also advance beyond root's patch without forcing unrelated targets or root to ship. The public Mac App Store release is `1.0.2` (live since 2026-07-24); the iPhone/iPad companion's own first release, also `1.0.2`, was rejected on 2026-08-04 and has not shipped.

Run `pnpm verify-version` before every build or release. CI rejects a `major.minor` compatibility split or a target-internal mismatch. Release CI additionally requires a channel tag's full `X.Y.Z` to equal that target's own declared version; it does not compare the tag's patch with root `VERSION`.

## Compatible line, independent patch and delivery

| Surface | Target version | Independent monotonic value | Tag / delivery |
|---|---|---|---|
| **Apple** (iOS+macOS) | `apple/project.yml` `MARKETING_VERSION` | `CURRENT_PROJECT_VERSION` (CI-owned) | `apple-v*` → TestFlight / App Store |
| **Android** | `android/app/build.gradle.kts` `versionName` | `versionCode` (currently 5) | `android-v*` → APK Release / optional Play |
| **npm** (`@agentdeck/hooks`, `shared`, `bridge`, `setup`) | public `package.json` files | npm registry version floor | `npm-v*` → manual publish |
| **ESP32** | `esp32/src/config.h` `FIRMWARE_VERSION` | build hash / epoch in firmware metadata | `esp32-v*` → firmware Release |
| **Stream Deck** | plugin manifest `Version` as `X.Y.Z.0` | fourth component if a same-product-version plugin rebuild is ever required | `streamdeck-v*` → Elgato Maker portal |
| **Ulanzi** | Ulanzi manifest `Version` | marketplace submission record | `ulanzi-v*` → Ulanzi Studio Marketplace |
| **Private JS workspaces** | their `package.json` files | not published | no independent delivery |

Tag prefixes remain because channels ship independently and may point to different commits. A patch bump updates only the target being delivered. A channel is considered shipped only when its prefixed tag and external release/submission exist. Do not claim an unsubmitted marketplace artifact as released merely because another target advanced.

## Version rules

1. All targets must share root `VERSION`'s `major.minor`; changing either component is a coordinated compatibility release.
2. Patch versions may differ by target without ordering constraints. `A.B.C` and `A.B.D` are mutually compatible for any numeric `C` and `D`; bump only the target being delivered.
3. Never reuse, delete-and-recreate, or lower a version that reached an external registry/store. Git tags do not reset external version floors.
4. Apple build number and Android versionCode increase only when those targets are actually built for delivery.
5. Public npm packages stay in lockstep and publish in dependency order: `hooks` + `shared` → `bridge` → `setup`.
6. Keep prefixed tags; there is no unprefixed repo-wide release tag.
7. Every release tag must exactly match its own target source (`apple-v1.0.3` requires Apple `MARKETING_VERSION` `1.0.3`, for example), even when root or another target has a different patch.
8. The only valid version reset is a genuinely new external identity (for example a new Apple bundle ID or npm package name). Document that migration before changing source versions.

## Hard external constraints

- **Apple / App Store Connect**: `CFBundleVersion` must increase. A lower marketing/build sequence is only possible with a new bundle ID and ASC record.
- **Android**: `versionCode` must increase for in-place upgrades and Play submission.
- **npm**: published versions are immutable. At convergence, registry floors were hooks `0.2.0`, shared `0.2.0`, bridge `0.2.2`, setup `0.2.0`, so the unified train begins at `0.2.3`.
- **Marketplaces**: plugin identifiers are immutable after distribution; only their versions advance.

## Preparing a target patch release

1. Choose the next SemVer for the target, preserving the shared `major.minor` compatibility line.
2. Update that target's internal mirrors. Do not bump unrelated targets merely to align patch values.
3. Increment Apple `CURRENT_PROJECT_VERSION` or Android `versionCode` only when releasing that target.
4. Update user-facing release notes and the delivery table in `README.md`.
5. Run `pnpm verify-version`, `pnpm build`, and the relevant platform workflows.
6. Commit the synchronized release state. Create only the channel tags that are actually being delivered, using the exact target version.

## Channel release steps

### npm (`@agentdeck/*`)

`hooks`, `shared`, `bridge`, and `setup` are public; root, plugin, and plugin-ulanzi are private. `bridge` has a runtime dependency on both `hooks` and `shared`, so all four must exist at the same product version. npm publishing requires a 2FA-enabled granular token.

1. Verify all four public npm manifests match each other and that the target version is unused on npm.
2. Run `pnpm build` and tests.
3. Publish the leaf packages `hooks` and `shared` first, then bridge, then setup.
4. Confirm each package's `latest` dist-tag matches the npm target version.
5. Tag the exact published commit as `npm-v<TARGET_VERSION>` and push it.

`npm-release.yml` runs on the tag: it re-verifies the version, builds, tests, and creates the GitHub Release. **Publishing stays manual by default** — step 3 above is still yours. To hand publishing to CI, set the repo variable `NPM_PUBLISH_ENABLED=true` and add an `NPM_TOKEN` secret holding a *granular automation* token (a 2FA-on-publish token cannot run unattended); the workflow then publishes in dependency order.

### Apple (TestFlight / App Store)

macOS has been publicly available since 2026-07-21 at [AgentDeck Dashboard on the Mac App Store](https://apps.apple.com/app/id6784822497), first as `1.0.0` and — since the 2026-07-24 approval of build 3901 — as `1.0.2`. The iPhone/iPad companion's first release (also `1.0.2`, build 3901) was **rejected on 2026-08-04 under Guideline 2.1(a)**. Build `4002` carrying the correction reached TestFlight, but the same run's macOS archive died on the certificate cap, and #124 then landed a push-to-talk repair that build predates — so `1.0.2` is superseded rather than resubmitted, and both platforms ship together as `1.0.3`. A successful CI upload reaches App Store Connect/TestFlight; public App Store release remains a separate App Store Connect action.

While a version sits in **Waiting for Review**, do not upload a replacement build for it: attaching one requires a developer reject, which loses the queue position without helping. Land further work on the next patch instead.

**A rejection is the opposite case, and it moves the tag.** A rejected version keeps its `MARKETING_VERSION`, so the replacement ships under the same Apple version — and rule 6 below requires the tag to match that version exactly. Re-pointing `apple-v<VERSION>` at the fix commit and force-pushing is therefore the intended path (CI derives the build number from `run_number * 100 + run_attempt`, so it stays monotonic across re-tags). The cost is that the tag no longer identifies the commit that produced the build already in the store: after a re-tag, that commit is recoverable only from the earlier workflow run for the same tag (`gh run list --workflow=apple-release.yml`). Record it in the changelog entry rather than relying on the tag.

1. Confirm Apple `MARKETING_VERSION` matches between `apple/project.yml` and the Xcode project mirror (`pnpm verify-version` checks this).
2. Run the Release build and App Store archive verifier described in `CLAUDE.md`.
3. Tag and push `apple-v<APPLE_VERSION>`; CI archives and uploads to TestFlight.

CI owns `CURRENT_PROJECT_VERSION` — `apple-release.yml` injects `github.run_number` into both archive steps, so the build number rises on every run and ASC never sees a duplicate `(version, build)` pair. Do not bump it by hand; the value in `apple/project.yml` is only a local-build default.

**Local builds**

```bash
bash scripts/build-apple-release.sh --ios     # local iOS build
bash scripts/build-apple-release.sh --macos   # local macOS build
bash scripts/build-apple-release.sh --all     # both + TestFlight upload
```

**Identity and signing**

- **Bundle ID**: `bound.serendipity.agent.deck` (App Store Connect 앱명: "AgentDeck Dashboard"). The Stream Deck **plugin UUID** `bound.serendipity.agentdeck` (no suffix) is a separate, immutable identifier and is unrelated to the app bundle ID.
- **Team**: 조직 `QF36NDHYHD` (Serendipity Bound) — 2026-07-10 개인 팀(R22679GY5Z)에서 이관. 서명은 **cloud signing** (`CODE_SIGN_STYLE=Automatic` + ASC API key `-allowProvisioningUpdates`); 수동 p12/프로파일 시크릿 불필요.
- **CI**: `.github/workflows/apple-release.yml` — `apple-v*` 태그 → macOS-15 runner → archive → TestFlight 업로드.
- **Secrets**: `ASC_API_KEY_ID`, `ASC_ISSUER_ID`, `ASC_API_KEY_BASE64` (조직 팀 App Manager+ 역할 키). Step-by-step setup: [docs/asc-cert-setup.md](docs/asc-cert-setup.md).

### Android (APK / optional Play)

1. Confirm the Android `versionName` remains on the shared compatibility line and increment `versionCode`.
2. Follow `.agents/workflows/build-android.md` for the signed release APK.
3. Tag and push `android-v<ANDROID_VERSION>` to create the GitHub Release. Optional Play upload remains gated by `ANDROID_PLAY_ENABLED` and its service-account secret.

### ESP32 firmware

1. Confirm `FIRMWARE_VERSION` remains on the shared compatibility line and run the relevant PlatformIO/hardware verification.
2. Confirm the `esp32-release.yml` build matrix still covers **every board marked Shipping** in the ESP32 board table of [docs/hardware-compatibility.md](docs/hardware-compatibility.md). A Shipping board absent from the matrix ships no firmware at all, and nothing else fails — the release simply comes out short, which is how `t_embed`, `t_display_pro` and `esp32_c6_147` had no binaries in `1.0.1`.
3. Tag and push `esp32-v<ESP32_VERSION>`.

Assets are named by the board's **canonical id** (`agentdeck-<board>.bin`) — the string the firmware reports as `device_info.board` and the one `agentdeck esp32-ota <target>` resolves, so a downloaded file is directly the OTA target. The PlatformIO env is a separate namespace and appears only in the notes table. The release notes are rendered from the built artifacts rather than a second hand-written list, so a board that built cannot be missing from the table describing it. `fail-fast` plus the release job's `needs: build` mean a partial firmware set never publishes.

### Stream Deck plugin

`1.0.2` was approved and published on 2026-07-28, `1.0.3` — the Windows compatibility correction — on 2026-07-31, and **`1.0.4` has been published since 2026-08-05**: [AgentDeck on the Elgato Marketplace](https://marketplace.elgato.com/product/agentdeck-dce3806b-176e-40f2-be7d-e029bec0f464). Now that builds are published, the Marketplace's **monotonic-version rule applies** — every subsequent submission needs a version above `1.0.4`, and same-version resubmission (which pre-publication review revisions allowed) is no longer available.

The live version is verifiable without signing in to the Maker Console: the product page is a client-rendered SPA, but its Next.js payload carries the version array verbatim, so `curl -s <product-url> | grep -oE '\\"versions\\":\[.{0,1200}'` reports `version_number`, `status`, and `publish_date` for every submission. Check it there before writing a release-status claim into this file — a portal upload that succeeds leaves no trace in the repository, which is exactly how these paragraphs fell a version behind between 2026-07-31 and 2026-08-06.

1. Confirm the main manifest and embedded profile snapshots match the Stream Deck package version as `X.Y.Z.0`.
2. Follow `.agents/workflows/build-plugin.md`, then run `pnpm package` — this validates with Elgato's official CLI (pinned as the `@elgato/cli` devDependency) before packing, so a local failure is a submission the Marketplace would have rejected.
3. Upload to the Elgato Maker portal and tag `streamdeck-v<STREAMDECK_VERSION>` when actually submitted/released.

`streamdeck-release.yml` runs on the tag: it validates, packs, attaches the `.streamDeckPlugin` to a GitHub Release, and uploads it as a build artifact. The Maker-portal upload itself stays manual — Elgato has no submission API.

### Ulanzi plugin

1. Confirm both Ulanzi package and marketplace manifests match each other.
2. Run `pnpm --filter @agentdeck/plugin-ulanzi package`, upload the artifact, and tag `ulanzi-v<ULANZI_VERSION>` when actually submitted/released.

`ulanzi-release.yml` runs on the tag and produces/attaches
`dist/com.ulanzi.ulanzistudio.agentdeck.ulanziPlugin.zip` the same way. The
archive basename deliberately matches its single top-level `.ulanziPlugin`
folder because the Marketplace rejects any other filename/root pairing. The
Marketplace upload stays manual.

The plugin declares **one** dynamic action; its keys reflow by agent state. Every localization file's `Actions` array is index-mapped onto `manifest.json`'s, so adding entries silently mislabels the action in the palette — `plugin-ulanzi/src/__tests__/manifest-localization.test.ts` gates that alignment.

## Marketplace plugins are thin clients

Stream Deck and Ulanzi plugins connect to the AgentDeck daemon on port 9120; they do not embed or spawn it. Marketplace listings must state that AgentDeck must be available through `npx @agentdeck/setup` or the macOS app. Do not bundle the daemon into a plugin or silently modify shell configuration from a marketplace install.

## Historical Apple identity change

The Apple app moved from the retired `bound.serendipity.agentdeck.dashboard` record to `bound.serendipity.agent.deck` in 2026-06. That new identity legitimately restarted App Store version/build numbering. It did not reset npm, Android installs, or any other existing external identity. Preserve this distinction in future migrations.
