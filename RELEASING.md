---
id: policy.releasing
title: Releasing and Versioning
description: Shared compatibility line, per-target patch versions, release tags, and monotonic constraints.
category: Engineering
locale: en
canonical: true
status: required
owner: Release maintainers
reviewed: 2026-08-10
revision: 2026-08-10
source_of_truth: RELEASING.md
validators: [node scripts/build-design-system-viewer.mjs --check, pnpm verify-version]
---

# Releasing & Versioning

AgentDeck uses one `major.minor` compatibility line across every maintained surface. Two numeric `X.Y.Z` product versions are mutually compatible if and only if their first two components match. Patch values are ignored in both directions: for example, `1.0.1` and `1.0.9` are compatible regardless of which side is newer.

Root [`VERSION`](VERSION) is the repository baseline and compatibility-line anchor, not a patch ceiling and not a runtime negotiation value. It currently reads **1.0.2**, so every maintained target must remain on compatibility line **1.0**. npm/CLI is at `1.0.17`; Stream Deck is at `1.0.5`; Android is at `1.0.8`; Apple is at `1.0.5`; ESP32 is at `1.0.4`; Ulanzi is at `1.0.3`. A target may also advance beyond root's patch without forcing unrelated targets or root to ship. **This sentence is a mirror, not a source** — take the declared values from `pnpm verify-version`, which reads each target's own manifest, and distinguish them from delivered state. As verified in the stores on 2026-08-10: Apple `1.0.5` is waiting for review on both platforms, Stream Deck `1.0.5` and Ulanzi `1.0.3` are pending review, Android Play `1.0.6` (versionCode 8) remains in review while Android `1.0.8` is available through GitHub Releases, and npm `1.0.17` is published.

Run `pnpm verify-version` before every build or release. CI rejects a `major.minor` compatibility split or a target-internal mismatch. Release CI additionally requires a channel tag's full `X.Y.Z` to equal that target's own declared version; it does not compare the tag's patch with root `VERSION`.

## A release has five states, and only one of them is "released"

CI going green is the first of five, not the last. Keep them apart in your head and in anything you write down:

1. **CI succeeded** — the workflow exited 0. This alone still proves only the workflow, not the destination. Before 2026-08-10 npm publishing was gated on an unset variable, so two tags produced green runs and published nothing; the current workflow makes publishing mandatory and verifies the registry before creating the GitHub Release.
2. **Artifact exists** — a GitHub Release carries the APK / `.streamDeckPlugin` / firmware.
3. **Uploaded to the store** — the binary reached ASC / Play / a marketplace portal. Nobody outside can install it yet.
4. **Submitted for review** — a human pressed a button in a portal. No tag, no workflow, and no repository artifact records this.
5. **Live** — the store distributes it.

**Never report a state you did not measure.** Each has its own instrument: the workflow log for 1, `gh release list` for 2, the portal or `npm view <pkg> version` for 3, and the portal for 4 and 5. Deriving one from another is how "released" gets claimed for a build sitting in a portal — it happened on 2026-08-09, when CI upload was reported as a completed Stream Deck and Ulanzi release while neither had been submitted.

### "Manual" means an interactive portal, not "only a human"

Several steps here are marked _manual_ or _a separate App Store Connect action_. That describes the **absence of an API**, not the absence of an agent. Portals accept a signed-in browser, and browser automation is available to agents working in this repo.

So an agent must not answer "I have no API access, so you'll have to do it." Before claiming a release step is impossible:

- load the browser tools (they are frequently _deferred_ — `ToolSearch` for `mcp__claude-in-chrome__*` rather than assuming they are absent), then `list_connected_browsers`;
- **read state freely** — Play Console review status, ASC build list and submission readiness, Maker Console and Ulanzi submission status. Reading changes nothing and is never worth blocking on;
- **ask before pressing a button that changes external state** — submitting for review, releasing to the public, replacing a build under review.

On 2026-08-09 an agent with those tools loaded from the first turn never invoked one, concluded from the word "manual" that portal work was user-only, and reported CI uploads as finished releases. The tools were not missing; they were not looked for.

### Apple build numbers are per-platform — read them, do not compute them

`CURRENT_PROJECT_VERSION` comes from `run_number * 100 + run_attempt`, so it is tempting to derive. Do not: **`build-macos` and `build-ios` are separate jobs, and a rerun of one advances only that one.** `apple-v1.0.5` shipped macOS as **4701** (attempt 1) and iOS as **4702** (attempt 2, after the iOS archive was rerun past a certificate cap). One number reported for both is wrong for one of them. Read each platform's build from App Store Connect.

## Compatible line, independent patch and delivery

| Surface                                                   | Target version                               | Independent monotonic value                                                | Tag / delivery                             |
| --------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| **Apple** (iOS+macOS)                                     | `apple/project.yml` `MARKETING_VERSION`      | `CURRENT_PROJECT_VERSION` (CI-owned)                                       | `apple-v*` → TestFlight / App Store        |
| **Android**                                               | `android/app/build.gradle.kts` `versionName` | `versionCode` (currently 7)                                                | `android-v*` → APK Release / optional Play |
| **npm** (`@agentdeck/hooks`, `shared`, `bridge`, `setup`) | public `package.json` files                  | npm registry version floor                                                 | `npm-v*` → manual publish                  |
| **ESP32**                                                 | `esp32/src/config.h` `FIRMWARE_VERSION`      | build hash / epoch in firmware metadata                                    | `esp32-v*` → firmware Release              |
| **Stream Deck**                                           | plugin manifest `Version` as `X.Y.Z.0`       | fourth component if a same-product-version plugin rebuild is ever required | `streamdeck-v*` → Elgato Maker portal      |
| **Ulanzi**                                                | Ulanzi manifest `Version`                    | marketplace submission record                                              | `ulanzi-v*` → Ulanzi Studio Marketplace    |
| **Private JS workspaces**                                 | their `package.json` files                   | not published                                                              | no independent delivery                    |

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

`hooks`, `shared`, `bridge`, and `setup` are public; root, plugin, and plugin-ulanzi are private. `bridge` has a runtime dependency on both `hooks` and `shared`, so all four must exist at the same product version. CI publishing authenticates with npm Trusted Publishing (OIDC); interactive maintenance still requires the maintainer's npm 2FA.

**The tarballs are machine-independent — keep them that way.** Publishing from an arm64 Mac, an Intel Mac, or CI Linux must produce byte-equivalent package contents. The one thing that used to violate this was the Foundation Models voice/judge helper: a `prepack` hook baked `assets/fm-helper/agentdeck-fm-helper` (a gitignored, arch-specific, ad-hoc-signed Mach-O) into whatever the publishing machine could build — so 1.0.13 shipped arm64-only from a dev Mac, and a CI publish would have silently shipped nothing. Since 1.0.14 the tarball carries only the helper's Swift source plus `scripts/build-fm-helper.mjs`, and the daemon compiles it on demand into `~/.agentdeck/fm-helper/` (macOS 26+, needs Xcode CLT; `bridge/src/foundation-models-helper.ts` also arch-checks any present binary so an Intel Mac never spawns an arm64 leftover). Never reintroduce a `prepack` that emits machine-built artifacts — `bridge/src/__tests__/fm-helper-arch.test.ts` gates this.

1. Verify all four public npm manifests match each other and that the target version is unused on npm.
2. Run `pnpm build` and tests.
3. Tag the exact release commit as `npm-v<TARGET_VERSION>` and push it. CI runs `node scripts/publish-npm.mjs`, which enforces the dependency order (`shared`+`hooks` → `bridge` → `setup`) and rewrites `workspace:*` around each publish. Do **not** substitute `pnpm publish`: pnpm (verified 11.5.2) uploads README.md inside the tarball but never attaches the readme to the registry packument, and npmjs.com renders the package page from the packument — that is why every @agentdeck page was blank through 1.0.14.
4. Confirm the workflow read all four exact versions back from npm, each package's `latest` dist-tag matches the target, and `npm view @agentdeck/setup readme` is non-empty.

`npm-release.yml` runs on the tag: it re-verifies the version, builds, tests, publishes in dependency order, reads all four exact versions back from the npm registry, and only then creates the GitHub Release. npmjs.com must configure a GitHub Actions **Trusted Publisher** for each public package with owner `puritysb`, repository `AgentDeck`, and workflow `npm-release.yml` (`npm publish` allowed). The workflow uses OIDC (`id-token: write`) and intentionally has no long-lived `NPM_TOKEN` or opt-in variable. Missing or drifted trust fails the release instead of producing a green no-op.

`scripts/publish-npm.mjs` is retry-safe across a partial four-package delivery: an exact immutable version already visible on npm is skipped, the missing packages continue in dependency order, and every package is verified again at the end. This does not make the registry optional — a tag is complete only when all four exact versions are readable there.

### Apple (TestFlight / App Store)

macOS has been publicly available since 2026-07-21 at [AgentDeck Dashboard on the Mac App Store](https://apps.apple.com/app/id6784822497), first as `1.0.0` and — since the 2026-07-24 approval of build 3901 — as `1.0.2`. The iPhone/iPad companion's first release (also `1.0.2`, build 3901) was **rejected on 2026-08-04 under Guideline 2.1(a)**.

**The two platforms diverged for four days, then reconverged.** `1.0.4` / build 4501 remains live on both platforms, and `1.0.5` was submitted on 2026-08-10 with platform-specific CI build numbers:

| Platform    | Version record | Build | State                                                                                                                                                                                  |
| ----------- | -------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS       | `1.0.5`        | 4701  | **Waiting for Review since 2026-08-10 09:35 KST**; `1.0.4` (4501) remains live. Builds 4301 and 4401 were withdrawn rather than shipped — each predated a fix that landed the same day |
| iPhone/iPad | `1.0.5`        | 4702  | **Waiting for Review since 2026-08-10 09:37 KST**; `1.0.4` (4501) remains live since 2026-08-07T22:57Z                                                                                 |

Approval mail alone cannot tell the platforms apart: three "eligible for distribution" messages arrived between 2026-08-05 and 2026-08-07 (iOS, macOS, iOS again) with a 2.1(a) rejection in between, and only the `(iOS)` / `(macOS)` in the subject distinguishes them. Read the state from App Store Connect.

iOS was answered as a `1.0.2` resubmission rather than moved up to `1.0.3`: a rejected version keeps its `MARKETING_VERSION`, and attaching the already-uploaded 4002 kept the reply and the binary consistent. macOS had no such constraint, so it went out at `1.0.3` with the newer 4101. **Do not describe an Apple release state from the tag or from the repository's own version numbers** — a single `apple-v*` tag can produce two builds whose store-side version records differ, as it did here. Read App Store Connect → 앱 심사 / App Review, whose submission table gives version, build and state per platform in one place.

**The iTunes lookup shortcut stopped answering for macOS the day the companion shipped.** While the app was Mac-only, `curl -s "https://itunes.apple.com/lookup?id=6784822497&entity=macSoftware"` returned a `mac-software` record whose `version` was the live Mac version — the fastest login-free release check there is. Once the iPhone/iPad companion went live, that id resolves to a single unified `software` record instead, and its `version`, `minimumOsVersion` (`17.0`) and `fileSizeBytes` all describe the **iOS** app; `entity=macSoftware`, `entity=iPadSoftware` and a store search all return that same record. So the endpoint still confirms the iOS side and its release timestamp, but the Mac version is no longer readable from it.

**The replacement Mac check is the receipt on the installed app, and it is better evidence than the lookup ever was.** A Mac App Store delivery leaves `Contents/_MASReceipt/` inside the bundle; a locally-built or notarized-outside-the-store copy does not. So on any Mac running the store build:

```bash
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" /Applications/AgentDeck.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c "Print :CFBundleVersion"            /Applications/AgentDeck.app/Contents/Info.plist
ls -d /Applications/AgentDeck.app/Contents/_MASReceipt && stat -f "installed: %Sm" /Applications/AgentDeck.app
```

The receipt proves the App Store _distributed_ that exact version-and-build, which is a stronger statement than "approved" — it is what confirmed macOS `1.0.4` (4501) was public on 2026-08-09, delivered to this machine at 11:49 local. Two limits: it reports what this Mac has, so a machine with auto-update off can lag the store, and it says nothing about a version still in review. For anything the receipt cannot answer — queue position, review state, a version you have not received — read App Store Connect.

A successful CI upload reaches App Store Connect/TestFlight; public App Store release remains a separate App Store Connect action.

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
- **Team**: 조직 `QF36NDHYHD` (Serendipity Bound) — 2026-07-10 개인 팀(R22679GY5Z)에서 이관. 2026-08-10부터 archive/export는 조직 전용 Distribution `.p12`와 명시적 App Store profiles를 쓰는 **manual signing**이다. ephemeral runner의 automatic signing이 release job마다 DEVELOPMENT 인증서를 새로 만들어 계정 상한을 세 차례 소진했기 때문이다. ASC API key는 업로드와 인증서 inventory에만 사용한다.
- **CI**: `.github/workflows/apple-release.yml` — `apple-v*` 태그 → macOS-15 runner → archive → TestFlight 업로드.
- **Secrets**: `APPLE_DISTRIBUTION_CERTIFICATE_BASE64`, `APPLE_INSTALLER_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`, iOS/macOS profile secrets, plus upload-only `ASC_API_KEY_ID` / `ASC_ISSUER_ID` / `ASC_API_KEY_BASE64`. Step-by-step setup and no-upload dry-run: [docs/asc-cert-setup.md](docs/asc-cert-setup.md).

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

`1.0.2` was approved and published on 2026-07-28, `1.0.3` — the Windows compatibility correction — on 2026-07-31, and `1.0.4` has been published since 2026-08-05: [AgentDeck on the Elgato Marketplace](https://marketplace.elgato.com/product/agentdeck-dce3806b-176e-40f2-be7d-e029bec0f464). **`1.0.5` was submitted on 2026-08-10 and is Pending review with automatic publishing enabled.** The uploaded CI artifact was the `streamdeck-v1.0.5` GitHub Release asset (`SHA-256 5cde49b7f79a2551c04113d1662b59720de3caa7929e2e8072dbcb3e458f6528`), not a locally rebuilt package. The Marketplace's **monotonic-version rule applies** — every subsequent submission needs a version above the latest published version, and same-version resubmission (which pre-publication review revisions allowed) is unavailable once that version is published.

The live version is verifiable without signing in to the Maker Console: the product page is a client-rendered SPA, but its Next.js payload carries the version array verbatim, so `curl -s <product-url> | grep -oE '\\"versions\\":\[.{0,1200}'` reports `version_number`, `status`, and `publish_date` for every submission. Check it there before writing a release-status claim into this file — a portal upload that succeeds leaves no trace in the repository, which is exactly how these paragraphs fell a version behind between 2026-07-31 and 2026-08-06.

1. Confirm the main manifest and embedded profile snapshots match the Stream Deck package version as `X.Y.Z.0`.
2. Follow `.agents/workflows/build-plugin.md`, then run `pnpm package` — this validates with Elgato's official CLI (pinned as the `@elgato/cli` devDependency) before packing, so a local failure is a submission the Marketplace would have rejected.
3. Upload to the Elgato Maker portal and tag `streamdeck-v<STREAMDECK_VERSION>` when actually submitted/released.

`streamdeck-release.yml` runs on the tag: it validates, packs, attaches the `.streamDeckPlugin` to a GitHub Release, and uploads it as a build artifact. The Maker-portal upload itself stays manual — Elgato has no submission API.

### Ulanzi plugin

`1.0.3` was uploaded to the Ulanzi portal and was verified as **under review** on 2026-08-10. Do not replace it while that review is active.

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
