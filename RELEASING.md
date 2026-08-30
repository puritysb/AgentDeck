---
id: policy.releasing
title: Releasing and Versioning
description: Shared compatibility major, per-target feature/fix versions, release tags, and monotonic constraints.
category: Engineering
locale: en
canonical: true
status: required
owner: Release maintainers
reviewed: 2026-08-26
revision: 2026-08-26
source_of_truth: RELEASING.md
validators: [node scripts/build-design-system-viewer.mjs --check, pnpm verify-version]
---

# Releasing & Versioning

AgentDeck uses one compatibility major across every maintained surface. Two numeric
`X.Y.Z` product versions are mutually compatible if and only if their first
component matches. Minor and patch values are ignored in both directions for
compatibility: for example, `1.0.9` and `1.3.0` are compatible regardless of which
side is newer.

The three components communicate release scope:

- **Major (`X`)** — a protocol compatibility break or an exceptionally large,
  coordinated product migration. Every maintained target moves together.
- **Minor (`Y`)** — a substantial backward-compatible feature or feature bundle.
  A target may advance independently while older same-major targets keep working.
- **Patch (`Z`)** — a small backward-compatible bug fix or refinement. Bump only
  the target being delivered.

Root [`VERSION`](VERSION) is the repository baseline and compatibility-major
anchor, not a minor/patch ceiling and not a runtime negotiation value. It
currently reads **1.0.2**, so every maintained target must remain on major **1**.
A target may advance its minor or patch without forcing unrelated targets or
root to ship. Read declared values from `pnpm verify-version`, which reads each
target's own manifest, and distinguish them from delivered state. The release
table in [`README.md`](README.md#releases) records delivered state only after it
has been measured with that channel's own instrument.

Three portal facts worth keeping from the recent Android delivery:

- **Android developer verification covers apps you ship OUTSIDE Play too.** The Play release was blocked by "이 출시를 진행하려면 모든 키를 등록하여…" even though the Play app-signing key was registered. The missing key was the **upload key** (`10:60:3A:F8…`), which is what `scripts/build-android-release.sh` signs the GitHub APK with. Registering it cleared the error immediately. Diagnose by comparing the fingerprints on the app-signing page against the registered list — a package showing `등록됨` is not proof that every key it ships under is there. Deleting an unrelated stale package entry does **not** help; that was tried first and changed nothing.
- **Saving a Play release does NOT submit it.** With managed publishing disabled, the release still lands as `아직 검토를 위해 전송되지 않음` on the track's 출시 tab, and the publishing overview reads `변경사항이 아직 검토를 위해 제출되지 않음` with a `검토를 위해 변경사항 N개 제출` button that must be pressed. The track summary says `최신 출시 버전: 12 (1.0.10)` either way, so that line cannot distinguish saved from submitted — read the per-release status, and confirm the summary flips to `출시 버전 12 (1.0.10) 검토 중`. Checking the publishing overview immediately after saving is also unreliable: it reported no pending changes while the save was still settling.
- **Play's release-notes field silently drops every language but the first on each save.** All three (`en-US`, `ko-KR`, `ja-JP`) must be re-pasted immediately before the final save, and the "N개의 언어로 출시 노트 제공됨" counter is the only confirmation that they took.

Run `pnpm verify-version` before every build or release. CI rejects a compatibility-major split or a target-internal mismatch. Release CI additionally requires a channel tag's full `X.Y.Z` to equal that target's own declared version; it does not compare the tag's minor or patch with root `VERSION`.

## A release has five states, and only one of them is "released"

CI going green is the first of five, not the last. Keep them apart in your head and in anything you write down:

1. **CI succeeded** — the workflow exited 0. This alone still proves only the workflow, not the destination. Before 2026-08-10 npm publishing was gated on an unset variable, so two tags produced green runs and published nothing; the current workflow makes publishing mandatory and verifies the registry before creating the GitHub Release.
2. **Artifact exists** — a GitHub Release carries the APK / `.streamDeckPlugin` / firmware.
3. **Uploaded to the store** — the binary reached ASC / Play / a marketplace portal. Nobody outside can install it yet.
4. **Submitted for review** — a human pressed a button in a portal. No tag, no workflow, and no repository artifact records this.
5. **Live** — the store distributes it.

**Never report a state you did not measure.** Each has its own instrument: the workflow log for 1, `gh release list` for 2, the portal or `npm view <pkg> version` for 3, and the portal for 4 and 5. Deriving one from another is how "released" gets claimed for a build sitting in a portal — it happened on 2026-08-09, when CI upload was reported as a completed Stream Deck and Ulanzi release while neither had been submitted.

### Every instrument above is keyed from a tag, so audit the tag surface too

`gh release list`, `git log <tag>..HEAD`, and the gap calculation all start from a
tag, so a version that shipped **without** one is invisible to every one of them —
it does not read as late or as broken, it does not read at all. Three cheap checks
close that blind spot, and they are the audit's own fourth leg beside tag / source /
external:

- **Local and remote tag sets are identical.** `git ls-remote --tags origin` against
  `git tag -l`; a tag that exists only locally has published nothing.
- **Every tag is reachable from `master`,** and tags and GitHub Releases pair 1:1
  with no drafts on either side.
- **Read the registry's whole version list, not just `latest`.**
  `npm view @agentdeck/bridge versions` is what surfaces a published-but-untagged
  version; `npm view … version` cannot, because it answers with the newest one.

That last check found `npm 1.0.14` on 2026-08-23 — live on the registry, no tag, no
Release, superseded six minutes later by 1.0.15, which is why the tag step never ran.
See CHANGELOG.md § Known gaps for the commit that is now its record.

**Do not backfill such a tag.** Since npm publishing became mandatory (state 1 above),
pushing `npm-v1.0.14` is not a bookkeeping fix — it is a publish attempt against a
version the registry already holds, and its first gate would fail anyway because
CHANGELOG.md forbids reconstructing the notes. Record the commit instead.

**Deleting a stale tag is also a content decision.** `verification-streamdeck-v1.0.3-windows.1`
looks like leftover scaffolding and is kept: a comment in the closed issue #88 links
to its release as the evidence of that Windows verification round, it is flagged
prerelease so it never reads as latest, and `verification-*` does not match the
`streamdeck-v*` workflow trigger. Check for inbound links before removing any tag.

### "Manual" means an interactive portal, not "only a human"

Several steps here are marked _manual_ or _a separate App Store Connect action_. That describes the **absence of an API**, not the absence of an agent. Portals accept a signed-in browser, and browser automation is available to agents working in this repo.

So an agent must not answer "I have no API access, so you'll have to do it." Before claiming a release step is impossible:

- load the browser tools (they are frequently _deferred_ — `ToolSearch` for `mcp__claude-in-chrome__*` rather than assuming they are absent), then `list_connected_browsers`;
- **read state freely** — Play Console review status, ASC build list and submission readiness, Maker Console and Ulanzi submission status. Reading changes nothing and is never worth blocking on;
- **ask before pressing a button that changes external state** — submitting for review, releasing to the public, replacing a build under review.

On 2026-08-09 an agent with those tools loaded from the first turn never invoked one, concluded from the word "manual" that portal work was user-only, and reported CI uploads as finished releases. The tools were not missing; they were not looked for.

### Apple build numbers are per-platform — read them, do not compute them

`CURRENT_PROJECT_VERSION` comes from `run_number * 100 + run_attempt`, so it is tempting to derive. Do not: **`build-macos` and `build-ios` are separate jobs, and a rerun of one advances only that one.** `apple-v1.0.5` shipped macOS as **4701** (attempt 1) and iOS as **4702** (attempt 2, after the iOS archive was rerun past a certificate cap). One number reported for both is wrong for one of them. Read each platform's build from App Store Connect.

### Reaching state 5 leaves a doc set behind, and no gate covers it

Going live changes what the repository should say, and nothing in CI notices when it doesn't. Google Play served AgentDeck from 2026-08-15; six days later `docs/roadmap.md` still carried `- [ ] Play Store distribution` unchecked and still described the iPhone/iPad companion as unreleased and awaiting resubmission, `marketplace/play/LISTING.md` was pinned at *"1.0.9 submitted; 1.0.6 live"*, and `.github/release-notes/android.md` — the install text appended to **every** Android GitHub Release — routed every visitor to sideloading with no Play link at all. `docs:check` and `design-system:check` were green the whole time: they verify links, anchors, and catalog coverage, never whether a sentence is still true.

So when a channel first goes live, sweep the surfaces that state its status: the landing page and `README.md` first, then `docs/roadmap.md`, then `marketplace/<channel>/LISTING.md`, then `.github/release-notes/<channel>.md`. The last one is the easiest to forget and the only one that shapes what a user does next.

**Play's live state reads without a console login.** `curl "https://play.google.com/store/apps/details?id=dev.agentdeck&hl=en"` returns the download bucket, the content rating, `Updated on`, and the localized *What's new* — so the notes a store is actually serving can be transcribed instead of reconstructed from the changelog — and `store/search?q=<term>&c=apps` measures whether the listing surfaces for anything besides its own name. Only the exact install count and the acquisition funnel (listing views versus installs) need the owner's login; that pair is what separates "nobody arrived" from "arrived and did not install".

## Shared major, independent minor/patch and delivery

| Surface                                                   | Target version                               | Independent monotonic value                                                | Tag / delivery                             |
| --------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| **Apple** (iOS+macOS)                                     | `apple/project.yml` `MARKETING_VERSION`      | `CURRENT_PROJECT_VERSION` (CI-owned)                                       | `apple-v*` → TestFlight / App Store        |
| **Android**                                               | `android/app/build.gradle.kts` `versionName` | `versionCode` (currently 11)                                               | `android-v*` → APK Release / optional Play |
| **npm** (`@agentdeck/hooks`, `shared`, `bridge`, `setup`) | public `package.json` files                  | npm registry version floor                                                 | `npm-v*` → manual publish                  |
| **ESP32**                                                 | `esp32/src/config.h` `FIRMWARE_VERSION`      | build hash / epoch in firmware metadata                                    | `esp32-v*` → firmware Release              |
| **Stream Deck**                                           | plugin manifest `Version` as `X.Y.Z.0`       | fourth component if a same-product-version plugin rebuild is ever required | `streamdeck-v*` → Elgato Maker portal      |
| **Ulanzi**                                                | Ulanzi manifest `Version`                    | marketplace submission record                                              | `ulanzi-v*` → Ulanzi Studio Marketplace    |
| **Private JS workspaces**                                 | their `package.json` files                   | not published                                                              | no independent delivery                    |

Tag prefixes remain because channels ship independently and may point to different commits. A minor or patch bump updates only the target being delivered. A channel is considered shipped only when its prefixed tag and external release/submission exist. Do not claim an unsubmitted marketplace artifact as released merely because another target advanced.

## Version rules

1. All targets must share root `VERSION`'s major. Changing it is a coordinated compatibility release.
2. Minor and patch versions may differ by target without ordering constraints. `A.B.C` and `A.D.E` are mutually compatible for any numeric `B`–`E`; bump only the target being delivered.
3. Never reuse, delete-and-recreate, or lower a version that reached an external registry/store. Git tags do not reset external version floors.
4. Apple build number and Android versionCode increase only when those targets are actually built for delivery.
5. Public npm packages stay in lockstep and publish in dependency order: `hooks` + `shared` → `bridge` → `setup`.
6. Keep prefixed tags; there is no unprefixed repo-wide release tag.
7. Every release tag must exactly match its own target source (`apple-v1.0.3` requires Apple `MARKETING_VERSION` `1.0.3`, for example), even when root or another target has a different minor or patch.
8. The only valid version reset is a genuinely new external identity (for example a new Apple bundle ID or npm package name). Document that migration before changing source versions.

## Hard external constraints

- **Apple / App Store Connect**: `CFBundleVersion` must increase. A lower marketing/build sequence is only possible with a new bundle ID and ASC record.
- **Android**: `versionCode` must increase for in-place upgrades and Play submission.
- **npm**: published versions are immutable. At convergence, registry floors were hooks `0.2.0`, shared `0.2.0`, bridge `0.2.2`, setup `0.2.0`, so the unified train begins at `0.2.3`.
- **Marketplaces**: plugin identifiers are immutable after distribution; only their versions advance.

## Preparing a target release

1. Choose the next SemVer for the target, preserving the shared compatibility major. Use minor for substantial backward-compatible features and patch for small fixes.
2. Update that target's internal mirrors. Do not bump unrelated targets merely to align minor or patch values.
3. Increment Apple `CURRENT_PROJECT_VERSION` or Android `versionCode` only when releasing that target.
4. **Write the `CHANGELOG.md` entry, and the delivery table in `README.md`.** The
   changelog is not a courtesy copy — `scripts/release-notes.mjs` renders the
   GitHub Release body from it, so an unwritten entry is a release page with an
   install blurb where its notes should be. Heading format is
   `## <YYYY-MM-DD> — <Channel> <version>`; list every channel in one heading
   when a round is cut across several, which is what a simultaneous cut is.
   Verify before tagging: `pnpm verify-release-version <target> <X.Y.Z>`.
5. Run `pnpm verify-version`, `pnpm build`, and the relevant platform workflows.
6. Commit the synchronized release state. Create only the channel tags that are actually being delivered, using the exact target version.

Step 4 used to say "update user-facing release notes" and was skipped without
consequence, because every workflow hardcoded its release body: the 2026-08-18
round shipped a whole new observed agent across five channels with no line about
it anywhere a user could read. Each release workflow now fails at its
`verify-release-version` step when the entry is missing — before anything is
built, published, or tagged.

Back-filling an **already published** body needs one correction to the rendered
output: `release-notes.mjs` pins its `Full changelog` link to the tag, which is
right at cut time and wrong retroactively. `android-v1.0.10` was cut on 08-17
and the entry describing it was written on 08-18, so that tag's tree holds a
`CHANGELOG.md` without this release's own notes — keep the link on `master`
when editing a published body.

## Channel release steps

### npm (`@agentdeck/*`)

`hooks`, `shared`, `bridge`, and `setup` are public; root, plugin, and plugin-ulanzi are private. `bridge` has a runtime dependency on both `hooks` and `shared`, so all four must exist at the same product version. CI publishing authenticates with npm Trusted Publishing (OIDC); interactive maintenance still requires the maintainer's npm 2FA.

**The tarballs are machine-independent — keep them that way.** Publishing from an arm64 Mac, an Intel Mac, or CI Linux must produce byte-equivalent package contents. The one thing that used to violate this was the Foundation Models voice/judge helper: a `prepack` hook baked `assets/fm-helper/agentdeck-fm-helper` (a gitignored, arch-specific, ad-hoc-signed Mach-O) into whatever the publishing machine could build — so 1.0.13 shipped arm64-only from a dev Mac, and a CI publish would have silently shipped nothing. Since 1.0.14 the tarball carries only the helper's Swift source plus `scripts/build-fm-helper.mjs`, and the daemon compiles it on demand into `~/.agentdeck/fm-helper/` (macOS 26+, needs Xcode CLT; `bridge/src/foundation-models-helper.ts` also arch-checks any present binary so an Intel Mac never spawns an arm64 leftover). Never reintroduce a `prepack` that emits machine-built artifacts — `bridge/src/__tests__/fm-helper-arch.test.ts` gates this.

1. Verify all four public npm manifests match each other and that the target version is unused on npm.
2. Run `pnpm build` and tests.
3. Pack all four packages from the exact release commit, install that candidate through
   the maintainer's real `agentdeck` command path, and complete the **three-mode
   daemon soak** below. A temporary-prefix smoke is useful but does not replace this
   gate: it does not exercise upgrades, the installed hook configuration, port 9120
   ownership, or the macOS app's hand-off behavior.
4. Tag the exact release commit as `npm-v<TARGET_VERSION>` and push it. CI runs `node scripts/publish-npm.mjs`, which enforces the dependency order (`shared`+`hooks` → `bridge` → `setup`) and rewrites `workspace:*` around each publish. Do **not** substitute `pnpm publish`: pnpm (verified 11.5.2) uploads README.md inside the tarball but never attaches the readme to the registry packument, and npmjs.com renders the package page from the packument — that is why every @agentdeck page was blank through 1.0.14.
5. Confirm the workflow read all four exact versions back from npm, each package's `latest` dist-tag matches the target, and `npm view @agentdeck/setup readme` is non-empty.

#### Pre-tag three-mode daemon soak

Run this from a clean checkout of the commit that will receive the tag. Record the
previous installed CLI version and a rollback command before replacing it. Also
record the macOS app's exact version and build: an npm-only release must test
against the currently delivered app, while a coordinated Apple+npm round uses the
Apple release candidate. Put the measured results in the release issue. All three
rows are required:

1. **Swift daemon only** — stop the CLI daemon, launch the recorded macOS app, and
   confirm port 9120 is owned by `AgentDeck` with `/health` reporting `isSwift:
   true`. Use at least one real directly launched agent turn and confirm that its
   state reaches the app plus at least one connected downstream surface. Do not
   run two copies with the same bundle identifier to stand in for this row.
2. **CLI daemon only** — quit the macOS app, start the installed release-candidate
   `agentdeck` daemon, and confirm the installed binary reports the target version
   and `/health` reports `isSwift: false`. Repeat a real agent turn and downstream
   surface update; also exercise one release-relevant CLI diagnostic or action.
3. **Both processes running** — launch the macOS app and the CLI daemon together.
   Confirm there is exactly one listener on 9120, the app defers to or attaches to
   the CLI daemon without a duplicate roster, and connected surfaces stay live.
   Stop the CLI daemon while leaving the app open and confirm the Swift daemon
   reclaims 9120 and the roster/surfaces recover without reinstalling hooks.

Do not tag on a launch-only observation. Each single-daemon row needs a real agent
turn and visible downstream delivery, and the coexistence row needs both takeover
and recovery. Any crash, duplicate session/device, stale state, lost hook, failed
port hand-off, or required manual repair blocks the tag until it is explained and
either fixed or explicitly waived in the release issue.

`npm-release.yml` runs on the tag: it re-verifies the version, builds, tests, publishes in dependency order, reads all four exact versions back from the npm registry, and only then creates the GitHub Release. npmjs.com must configure a GitHub Actions **Trusted Publisher** for each public package with owner `puritysb`, repository `AgentDeck`, and workflow `npm-release.yml` (`npm publish` allowed). The workflow uses OIDC (`id-token: write`) and intentionally has no long-lived `NPM_TOKEN` or opt-in variable. Missing or drifted trust fails the release instead of producing a green no-op.

`scripts/publish-npm.mjs` is retry-safe across a partial four-package delivery: an exact immutable version already visible on npm is skipped, the missing packages continue in dependency order, and every package is verified again at the end. This does not make the registry optional — a tag is complete only when all four exact versions are readable there.

### Apple (TestFlight / App Store)

macOS has been publicly available since 2026-07-21 at [AgentDeck Dashboard on the Mac App Store](https://apps.apple.com/app/id6784822497), first as `1.0.0` and — since the 2026-07-24 approval of build 3901 — as `1.0.2`. The iPhone/iPad companion's first release (also `1.0.2`, build 3901) was **rejected on 2026-08-04 under Guideline 2.1(a)**.

**The two platforms diverged for four days, then reconverged.** `1.0.5` was submitted on 2026-08-10 with platform-specific CI build numbers; it and the two releases after it are now live on both platforms:

| Platform    | Version record | Build | State                                                                                                                                                                                  |
| ----------- | -------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS       | `1.0.5`        | 4701  | **Live**; the public App Store page's Mac platform reports `1.0.5`. Builds 4301 and 4401 were withdrawn rather than shipped — each predated a fix that landed the same day |
| iPhone/iPad | `1.0.5`        | 4702  | **Live**; Apple's lookup API reports `1.0.5`, released 2026-08-10T19:35:58Z                                                                    |
| macOS       | `1.0.6`        | 5101  | **Live**; the public App Store page with `platform=mac` reports `Version 1.0.6` and the submitted release notes.                                |
| iPhone/iPad | `1.0.6`        | 5101  | **Live**; the public App Store default iPhone/iPad page reports `Version 1.0.6` and the submitted release notes.                                |
| macOS       | `1.0.7`        | 5201  | **Live**; the public App Store page with `platform=mac` reports `Version 1.0.7`, released 2026-08-19T22:11Z.                                    |
| iPhone/iPad | `1.0.7`        | 5201  | **Live**; Apple's lookup API reports `1.0.7`, released 2026-08-18T17:06Z.                                                                       |

`1.0.6` was submitted for both platforms on 2026-08-13 with **build 5101**, approved, and automatically released. Build 4901 was the initial upload from tag commit `9165ef98`. After the review-prompt timing fix landed in PR #180, workflow-dispatch run `31606319424` uploaded build 5001 from merge commit `6de6a408`. PR #182 then fixed concurrent Codex usage-snapshot freshness in the Swift app; workflow-dispatch run `31608454704` uploaded build 5101 for both platforms from merge commit `7ee2039d`. The released build is 5101, not 4901 or 5001, with the English, Korean, and Japanese `What's New` copy plus the platform-specific review notes. Public iPhone/iPad and Mac platform pages both report `Version 1.0.6`.

`1.0.7` went out for both platforms on **build 5201** and was approved and automatically released. **The two platforms did not go live together:** iOS was released 2026-08-18T17:06Z and macOS only 2026-08-19T22:11Z — 29 hours later, from that one submission. During that gap App Store Connect showed iOS at `배포 준비됨` while macOS was still in review — which is the concrete reason the per-platform state has to be read per platform, and why an approval mail for one says nothing about the other.

Approval mail alone cannot tell the platforms apart: three "eligible for distribution" messages arrived between 2026-08-05 and 2026-08-07 (iOS, macOS, iOS again) with a 2.1(a) rejection in between, and only the `(iOS)` / `(macOS)` in the subject distinguishes them. Read the state from App Store Connect.

iOS was answered as a `1.0.2` resubmission rather than moved up to `1.0.3`: a rejected version keeps its `MARKETING_VERSION`, and attaching the already-uploaded 4002 kept the reply and the binary consistent. macOS had no such constraint, so it went out at `1.0.3` with the newer 4101. **Do not describe an Apple release state from the tag or from the repository's own version numbers** — a single `apple-v*` tag can produce two builds whose store-side version records differ, as it did here. Read App Store Connect → 앱 심사 / App Review, whose submission table gives version, build and state per platform in one place.

**The iTunes lookup shortcut stopped answering for macOS the day the companion shipped.** While the app was Mac-only, `curl -s "https://itunes.apple.com/lookup?id=6784822497&entity=macSoftware"` returned a `mac-software` record whose `version` was the live Mac version — the fastest login-free release check there is. Once the iPhone/iPad companion went live, that id resolves to a single unified `software` record instead, and its `version`, `minimumOsVersion` (`17.0`) and `fileSizeBytes` all describe the **iOS** app; `entity=macSoftware`, `entity=iPadSoftware` and a store search all return that same record. The endpoint can also lag the public product page during release propagation: when both public platform pages already showed 1.0.6 on 2026-08-13, lookup still returned iOS 1.0.5. Use it as a convenient iOS signal, not the sole release authority; the Mac version is not readable from it.

**The replacement Mac check is the receipt on the installed app, and it is better evidence than the lookup ever was.** A Mac App Store delivery leaves `Contents/_MASReceipt/` inside the bundle; a locally-built or notarized-outside-the-store copy does not. So on any Mac running the store build:

```bash
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" /Applications/AgentDeck.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c "Print :CFBundleVersion"            /Applications/AgentDeck.app/Contents/Info.plist
ls -d /Applications/AgentDeck.app/Contents/_MASReceipt && stat -f "installed: %Sm" /Applications/AgentDeck.app
```

The receipt proves the App Store _distributed_ that exact version-and-build, which is a stronger statement than "approved" — it is what confirmed macOS `1.0.4` (4501) was public on 2026-08-09, delivered to this machine at 11:49 local. Two limits: it reports what this Mac has, so a machine with auto-update off can lag the store, and it says nothing about a version still in review. On 2026-08-12 this Mac still had the `1.0.4` (4501) receipt while the public Mac product page already reported `1.0.5`, a concrete example of that lag. For anything the receipt cannot answer — queue position, review state, a version you have not received — read App Store Connect or the platform-specific public product page.

A successful CI upload reaches App Store Connect/TestFlight; public App Store release remains a separate App Store Connect action.

While a version sits in **Waiting for Review**, do not upload a replacement build for it: attaching one requires a developer reject, which loses the queue position without helping. Land further work on the next patch instead.

**A rejection is the opposite case, and it moves the tag.** A rejected version keeps its `MARKETING_VERSION`, so the replacement ships under the same Apple version — and rule 6 below requires the tag to match that version exactly. Re-pointing `apple-v<VERSION>` at the fix commit and force-pushing is therefore the intended path (CI derives the build number from `run_number * 100 + run_attempt`, so it stays monotonic across re-tags). The cost is that the tag no longer identifies the commit that produced the build already in the store: after a re-tag, that commit is recoverable only from the earlier workflow run for the same tag (`gh run list --workflow=apple-release.yml`). Record it in the changelog entry rather than relying on the tag.

**Submitting is per platform, and the portal will not tell you that.** `심사에 추가`
on the iOS version creates an *iOS* submission draft; doing it on macOS creates a
*second, separate* draft. The panel's back link shows both ("iOS 제출 초안(1개)",
"macOS 제출 초안(1개)") and each needs its own `심사를 위해 제출`. Submitting one and
walking away leaves the other sitting in `제출 준비 중` looking done — which is the
same trap as reading an approval mail without its `(iOS)` / `(macOS)` suffix.

**An App Store Connect session expires mid-edit and the UI does not say so.** The
save button turns red with an error glyph and nothing explains why; the requests
behind it are `401` on `PATCH /iris/v1/appStoreVersionLocalizations/…`. It looks
exactly like a validation failure on the field you just typed. Check the network
panel before hunting for a bad field, sign in again in the same tab, and press
save once more — unsaved edits survive the re-auth, so nothing has to be retyped.
Then reload and re-read every locale: a save that failed this way leaves the form
looking correct while the server still holds the previous text.

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

**Privacy-preserving usage analytics**

AgentDeck does not ship an analytics SDK or send product events to an AgentDeck server. Use Apple's opt-in, privacy-thresholded aggregate reports instead. Creating either kind of analytics report request (`init` or `snapshot`) requires an **Admin** API key. After a request exists, Admin, Finance, or Sales and Reports access can download its reports. The script accepts the release-secret names above or the shorter `ASC_KEY_ID` / `ASC_KEY_BASE64` aliases used by other maintenance scripts.

```bash
pnpm analytics:apple -- status                         # read-only: show requests
pnpm analytics:apple -- init                           # Admin: ongoing reports
pnpm analytics:apple -- snapshot                       # Admin: all available history
pnpm analytics:apple -- fetch --request REQUEST_ID --days 30
```

Run `snapshot` once when onboarding an existing app, save the returned request id, and fetch that id to capture all historical data Apple makes available. Keep the `ONGOING` request for new daily batches. Apple normally needs 1–2 days to produce a new request. `--days` filters **report processing dates**, not the event dates inside the downloaded rows, so it does not limit a snapshot to the last 30 days. Exports land under the gitignored `reports/app-store-connect/` directory. Usage rows represent only users who enabled sharing with Apple and developers, and low-volume rows can be absent because Apple applies privacy thresholds; treat these as directional retention signals, not a census. Re-run `fetch` regularly because Apple can add late-arriving or corrected batches.

### Android (Google Play + APK)

1. Confirm the Android `versionName` remains on the shared compatibility major and increment `versionCode`. Play refuses any upload whose `versionCode` is not strictly higher than the live one.
2. Follow `.agents/workflows/build-android.md` for the signed release APK.
3. Tag and push `android-v<ANDROID_VERSION>` to create the GitHub Release. CI's Play upload stays gated by `ANDROID_PLAY_ENABLED` and its service-account secret, so in practice the AAB is built locally (`./gradlew bundleRelease`) and uploaded through the console — see [marketplace/play/LISTING.md](marketplace/play/LISTING.md) for the runbook, including that saving a release is not submitting it and that release notes keep only the first language across a save.

### ESP32 firmware

1. Confirm `FIRMWARE_VERSION` remains on the shared compatibility major and run the relevant PlatformIO/hardware verification.
2. Confirm the `esp32-release.yml` build matrix still covers **every board marked Shipping** in the ESP32 board table of [docs/hardware-compatibility.md](docs/hardware-compatibility.md). A Shipping board absent from the matrix ships no firmware at all, and nothing else fails — the release simply comes out short, which is how `t_embed`, `t_display_pro` and `esp32_c6_147` had no binaries in `1.0.1`.
3. Tag and push `esp32-v<ESP32_VERSION>`.

**Ordering is forced when a round also ships the flasher or the CLI.** Both
consume the release's `manifest.json` and merged images, so those must exist
first:

1. `esp32-v<next>` — publishes `agentdeck-<board>-merged.bin` and `manifest.json`.
2. Push to `master` — `test-report.yml` resolves that tag, downloads the
   `webFlash` boards' merged images into `_site/flash/fw/<tag>/`, verifies each
   sha256 against the manifest, and deploys `/flash/`. Before an esp32 release
   with a manifest exists, this step states that the release predates the
   merged-image pipeline and the page deploys with no firmware — it says so in
   the user's own language rather than failing the whole site.
3. `npm-v<next>` — `agentdeck esp32 flash`, which reads the manifest from the
   **Release**, not from Pages (it is not in a browser, so CORS does not apply,
   and Pages can lag a firmware cut by a whole master push).

**A flash-size change in `shared/src/esp32-boards.ts` makes that order mandatory
rather than merely preferable.** The write-time preflight compares the release
manifest's geometry against the board SSOT with **strict equality**, in both
directions — because the two are descriptions of the same board from sources
that are supposed to agree, and because it is the only size check left on a
board whose flash id cannot be read (a stubless TTGO answers `0xffffff`). So
between an SSOT flash-size edit and the Pages redeploy that carries the matching
manifest, the browser flasher refuses that board with `image-geometry-mismatch`.
That is the guard working, not a regression: cut the `esp32-v*` release first,
then push master.

Assets are named by the board's **canonical id** (`agentdeck-<board>.bin`) — the string the firmware reports as `device_info.board` and the one `agentdeck esp32-ota <target>` resolves, so a downloaded file is directly the OTA target. The PlatformIO env is a separate namespace and appears only in the notes table. The release notes are rendered from the built artifacts rather than a second hand-written list, so a board that built cannot be missing from the table describing it. `fail-fast` plus the release job's `needs: build` mean a partial firmware set never publishes.

### Stream Deck plugin

`1.0.2` was approved and published on 2026-07-28, `1.0.3` — the Windows compatibility correction — on 2026-07-31, and `1.0.4` on 2026-08-05. `1.0.5` was published on 2026-08-10T18:03:56Z. **`1.0.6` was published on 2026-08-18T16:46Z** and is now the latest public version at [AgentDeck on the Elgato Marketplace](https://marketplace.elgato.com/product/agentdeck-dce3806b-176e-40f2-be7d-e029bec0f464) — the product page's `versions` payload reports `status: published` and `latest_version_number: 1.0.6`. For `1.0.5` the uploaded CI artifact was the `streamdeck-v1.0.5` GitHub Release asset (`SHA-256 5cde49b7f79a2551c04113d1662b59720de3caa7929e2e8072dbcb3e458f6528`), not a locally rebuilt package; the same rule applies to every submission. The Marketplace's **monotonic-version rule applies** — every subsequent submission needs a version above the latest published version, and same-version resubmission (which pre-publication review revisions allowed) is unavailable once that version is published.

The live version is verifiable without signing in to the Maker Console: the product page is a client-rendered SPA, but its Next.js payload carries the version array verbatim, so `curl -s <product-url> | grep -oE '\\"versions\\":\[.{0,1200}'` reports `version_number`, `status`, and `publish_date` for every submission. Check it there before writing a release-status claim into this file — a portal upload that succeeds leaves no trace in the repository, which is exactly how these paragraphs fell a version behind between 2026-07-31 and 2026-08-06.

1. Confirm the main manifest and embedded profile snapshots match the Stream Deck package version as `X.Y.Z.0`.
2. Follow `.agents/workflows/build-plugin.md`, then run `pnpm package` — this validates with Elgato's official CLI (pinned as the `@elgato/cli` devDependency) before packing, so a local failure is a submission the Marketplace would have rejected.
3. Upload to the Elgato Maker portal and tag `streamdeck-v<STREAMDECK_VERSION>` when actually submitted/released.

`streamdeck-release.yml` runs on the tag: it validates, packs, attaches the `.streamDeckPlugin` to a GitHub Release, and uploads it as a build artifact. The Maker-portal upload itself stays manual — Elgato has no submission API.

### Ulanzi plugin

`1.0.3` was uploaded on 2026-08-07 and **published on or before 2026-08-24** — the first AgentDeck version ever live on this Marketplace. `1.0.4` was **submitted the same day** as a *Create review version* (D200X keypad, the three agents the published build predates, three new locales, `AI` sub-category, restored seven-language copy, refreshed media); 1.0.3 keeps serving while it is reviewed, verified on the public page after the press. **`1.0.5` replaced that review record in place on 2026-08-25**, so 1.0.4 never reached a user: the Ulanzi Studio team reported macOS Gatekeeper flagging `resvgjs.darwin-arm64.node` on Apple Silicon, and 1.0.5 removes every native binary by moving the rasterizer to `@resvg/resvg-wasm`. Replacing rather than stacking a second review version is the path Ulanzi confirmed on 2026-08-08 ("it's also possible to re-edit and update the file"), and it is the right one here because the reviewer was testing the very build that was wrong. Published is still **1.0.3**; under review is **1.0.5**.

**An update is a new review version, not an edit of the live listing.** The portal was rebuilt some time between 2026-08-08 and 2026-08-24: the published card's pencil now opens *Create review version*, which states that "the published version stays unchanged and remains available until the new version is approved". That retires the old rule that a version under review must not be touched — it applied when the record under review *was* the only record. The live 1.0.3 listing keeps serving downloads while 1.0.4 is reviewed.

The rebuilt form also changed what a submission carries. Recorded here because the portal is the only place these constraints exist: cover **1:1**, banners **3:2** (1 required, up to 3), main file ≤50 MB, `Name` 40 / `Summary` **300** / `Detailed introduction` **1000** characters **per language across all seven** (中文 · English · German · Japanese · Korean · Portuguese · Spanish, with a *Copy English to current* button), plus category, unique ID, update note, supported languages/devices (D200 · D200H · D200X · Dial) and systems (Windows · macOS Apple Silicon · macOS Intel).

Two facts about the live record, read from that form on 2026-08-24 and both worth fixing in the 1.0.4 submission: its sub-category is **Office** (the AI-agent plugins next to it — Codex Micro, Claude Code Usage — sit under **AI**), and every one of the seven `Summary`/`Detailed introduction` pairs holds the same single sentence (English: 51 of 300 and 51 of 1000 characters). The full seven-language copy this repository already carries in [marketplace/ulanzi/LISTING.md](marketplace/ulanzi/LISTING.md) is not what is published.

1. Confirm both Ulanzi package and marketplace manifests match each other.
2. Run `pnpm --filter @agentdeck/plugin-ulanzi package`, upload the artifact, and tag `ulanzi-v<ULANZI_VERSION>` when actually submitted/released. **The tag follows the submission, and that ordering is deliberate** — state 4 above is the one nothing in this repository records, so the tag is what records it; tagging first creates a tag for a version that may never be submitted.
3. **Uploading the ZIP re-enables every Supported device, `Dial` included.** The form parses the manifest and fills `Version` correctly (verified 1.0.5), then silently turns the whole device set back on. We do not implement the Dial's encoders, so it must be switched off by hand — and selected/unselected are only weakly distinguishable on screen, so read `document.querySelectorAll('button.toggle')` and check `className.includes('selected')` rather than trusting the screenshot.
4. **A toast is not a server write.** Re-open the dialog afterwards and read the values back: the main file must show a *new* CDN hash (`<32-hex>.zip`), never a local filename and never the previous version's hash.

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
