---
id: policy.releasing
title: Releasing and Versioning
description: Shared compatibility major and feature milestones, target-specific patches, release decisions, and delivery evidence.
category: Engineering
locale: en
canonical: true
status: required
owner: Release maintainers
reviewed: 2026-10-13
revision: 2026-10-13
source_of_truth: RELEASING.md
validators: [node scripts/build-design-system-viewer.mjs --check, pnpm verify-version]
---

# Releasing & Versioning

AgentDeck uses one compatibility major across every maintained surface. Two numeric
`X.Y.Z` product versions are mutually compatible if and only if their first
component matches. Minor and patch values are ignored in both directions for
compatibility: for example, `1.0.9` and `1.3.0` are compatible regardless of which
side is newer.

## Choosing a version

**Version scope follows the user-visible contract, not implementation effort,
the number of commits, or the number of release attempts.** Classify the delta
from the last delivered version of each channel before editing manifests.

| Component | Meaning across every distribution channel | Examples |
| --- | --- | --- |
| Major (`X`) | A protocol compatibility break or backward-incompatible coordinated product migration; maintained targets move together | A wire contract that older same-major peers cannot use |
| Minor (`Y`) | A named product feature milestone with a substantial new, usable capability | A new end-to-end control workflow or supported device family |
| Patch (`Z`) | Restores, completes or improves an existing promised capability without a compatibility break; patch numbers may differ by target | Broken/incomplete rollout, crash, frame pacing, performance, onboarding repair, rendering parity, signing or packaging fix |
| Build / artifact identity | Identifies a rebuild or submission attempt of the same unreleased product version | Android `versionCode`, Apple `CFBundleVersion`, source SHA and artifact hash |

A large rewrite that fixes an existing feature is still a patch. Completing
an incomplete 1.9 experience is a 1.9.x correction, even if it finally becomes
usable. A first-time substantial capability is a minor only when the release
plan can state what users can newly accomplish. When the distinction is unclear,
default to patch; do not manufacture a feature milestone to justify a number.

### Keep channel meanings aligned

- Allocate new **minor milestones product-wide**, with a name and concrete
  acceptance scope. Channels shipping that milestone use the same `X.Y`;
  minor is not a separate per-store release counter. Allocate the next milestone
  above already published/reserved minors so historical numbers are not reused.
- Each channel can deliver patches and reach a milestone on its own schedule.
  Publish only changed, verified targets; do not ship an empty update merely to
  make numbers match. Delayed targets can skip unused minor numbers when they
  deliver a later milestone. Do not rename an already promised feature's late
  repair as a new minor feature.
- Record applicability and missing capabilities per target in the release plan.
  Shared `X.Y` means the same product milestone, not identical hardware features
  or simultaneous Store approval. A device's capability is established by its
  feature matrix/protocol, not inferred from its minor version.
- GitHub APK and Google Play are delivery routes for **one Android product
  version**, not separately numbered products. The same applies to Store/direct
  routes of any target. Distinguish source, artifact hash, signing identity,
  build number and delivered state when packaging differs.
- Keep historical published versions. Never delete/reassign a public tag,
  relabel a released binary, downgrade a channel, or reuse a consumed store build
  number to make a table look aligned. Reconcile historical differences at the
  next real shared milestone, not with cosmetic releases.

Root [`VERSION`](VERSION) is the compatibility-major anchor, not the latest
product release and not a runtime negotiation value. It currently reads
**1.0.2**, so maintained targets stay on major **1**. Same-major minor/patch
versions remain compatible in both directions. A target-specific patch does
not force root or other targets to change.

### Record the decision before release work

Before changing version manifests, creating a tag or uploading a binary, put a
release decision in the release PR (or the existing release record):

| Target / routes | Last verified public version | Uploaded/reserved version + build | Proposed version + build | Class and user-visible reason | Product milestone / applicability |
| --- | --- | --- | --- | --- | --- |
| Example Android / Play + GitHub | 1.9.0 | 1.9.0 / 26 | 1.9.1 / 27 | Patch: complete the promised background display and remove frame stalls | Existing 1.9 scope; no new milestone |

State the previous→new behavior and tests, plus targets that are unchanged or
still pending. Treat unshipped manifest values as candidates, not permission to
publish those numbers. Recheck the portal's consumed version/build floor before
upload. A metadata-only correction or rebuild of an unreleased version keeps
its product version when the destination permits it; increment the required
build identifier instead. Once a product version is public, changed executable
content needs a new patch or a justified feature milestone. A portal constraint
can force a higher patch/build; it never makes a bug fix a minor feature.

`pnpm verify-version` enforces manifest consistency and the compatibility major;
release CI also checks the exact channel tag and CHANGELOG entry. These checks
**do not judge whether a change deserves minor or patch**. The release decision
above and PR review own that judgment. After delivery, update the
[README release table](README.md#releases) and the per-channel receipt from
observed portal/artifact state; do not present a candidate as public.

### 2026-10-13 remaining release decision

Checked before changing manifests: [ASC status run](https://github.com/puritysb/AgentDeck/actions/runs/38322073839),
npm registry, GitHub release tags, Maker Console Versions and Ulanzi published/review records.
No new product milestone is allocated. Android 1.10.0 / 27 remains immutable.
The subsequent dashboard-inspection repair is Android 1.10.1 / 28: Play's bundle
list was checked on 2026-10-13 and its latest uploaded code was 27. This fixes the
existing selection/filter contract rather than introducing a new minor milestone.

| Target / routes | Last verified public | Uploaded / reserved | Proposed | Class and previous → new behavior | Applicability |
| --- | --- | --- | --- | --- | --- |
| Android / Play + GitHub | 1.10.0 / 27 | 27 is the latest uploaded bundle | 1.10.1 / 28 | Patch: isolate dashboard history selection, restore Codex member filtering and add the missing native 3D tap route | Existing dashboard interaction; retain delivered 1.10.0 identity |
| Apple / iOS + macOS | 1.9.0 on both platforms | 1.9.0 / 7901; no 1.10 upload | 1.9.1; CI build above 7901 | Patch: repair setup/connection flows, preserve partial APME costs, complete background display counts and isolate dashboard history selection | Existing dashboard and device behavior; Dot remains excluded |
| npm / four public packages | 1.9.0 | 1.9.0 | 1.9.1 | Patch: complete existing background-work propagation and live matrix counts | Existing daemon/device contract |
| ESP32 / firmware assets | 1.9.0 | esp32-v1.9.0 | 1.9.1 + source build identity | Patch: complete LCD/e-ink background indicators and replace TC001 window labels with reset countdowns | Existing shipping boards; panel-appropriate presentation |
| Stream Deck / GitHub + Marketplace | 1.8 (package 1.8.0) | 1.8 published; no newer row | 1.8.1 (manifest 1.8.1.0) | Patch: retain background counts across partial updates and complete session-key rendering | Existing keys/encoders; no new device capability |
| Ulanzi / GitHub + Marketplace | 1.6.0 Marketplace; 1.8.0 GitHub | 1.8.0 under review | 1.8.1 | Patch: complete background state rendering and expire stale Dot state | Existing D200H/D200X keypad behavior; no Dial support |

Delivery update, 2026-10-13 (PR #526 at `0acb96c4`; handover repair #527 at `88e31aa0`):

- Apple iOS/macOS **1.9.1 / 8501 submitted; Waiting for Review**, observed in
  App Store Connect on October 13 at 22:02 / 22:10 KST. Both signed archive/export
  checks and uploads passed ([run 38399345348](https://github.com/puritysb/AgentDeck/actions/runs/38399345348)).
  Native iPhone/iPad XCUITest exposed timeline rows intercepting the clear button;
  [#529](https://github.com/puritysb/AgentDeck/pull/529) fixes the hit bounds and
  adds the standalone acceptance runner. Both devices passed select, replace and
  clear after the fix. The earlier macOS 8401 submission was withdrawn; 8501
  supersedes it without changing the marketing version. Full verification passed
  ([receipt](verification/receipts/2026-10-13-f517fcb.json)). Submission IDs:
  iOS `4d92fb05-f234-42ef-affc-709a99afe436`, macOS
  `2c7e560d-3d42-49b5-be3d-caaa4e1603ba`. Both auto-release after approval;
  neither is confirmed live. Local deployment of merged `d0e9f06d` also passed.
- Android **1.10.1 / 28 submitted to production Play; in review**, with managed
  publishing off and a full rollout to the existing 178 countries after approval.
  The Play-signed Lenovo build passed native 3D Codex/OpenClaw selection and clear;
  the Mac's independent filter remained unchanged. The
  [GitHub APK](https://github.com/puritysb/AgentDeck/releases/tag/android-v1.10.1)
  is public and its downloaded SHA-256 matches the published artifact.
- Stream Deck **1.8.1 is public on GitHub and Pending review in Maker Console**;
  auto-publish is off for DRM encoder acceptance. The submitted CI package SHA-256
  is `a90a870b8ed6f0b6c991515355ac055b30885c96315484f751df46e533c75a9e`.
- Ulanzi **1.8.1 is public on GitHub and under Marketplace review**, replacing the
  pending 1.8.0. All seven listing locales were restored after ZIP upload;
  unsupported Dial/AU05 remain unchecked. The installed Studio process was
  restarted and verified against bundle SHA-256
  `4f4bdca407965ad9d1ef6c7e497c08469c075f9b699d66d74c9edeb79cd8bb55`.
- npm **1.9.1 is public**, with all four exact versions and `latest` tags read
  back after [release run 38384949327](https://github.com/puritysb/AgentDeck/actions/runs/38384949327).
  Registry integrity checks pass for all four tarballs; all 320 runtime JS files
  match the verified candidate. The setup registry README is nonempty.
  Installed-package acceptance exposed missing timeline handover in both
  directions; #527 fixes it. Real CLI-only and Swift-only turns reached Mac and
  Lenovo, both histories survived takeover, and Swift recovered port 9120 in
  138.772 seconds. Dashboard readiness now precedes device discovery.
  The persistent main CLI link is restored, and automatic local deployment of
  `88e31aa0` passed with daemon build `b9bb2770bf62` and verified Stream Deck runtime.
- ESP32 **1.9.1 is public at `0acb96c4`**, with 12 boards and 62 release assets
  ([run 38379792242](https://github.com/puritysb/AgentDeck/actions/runs/38379792242)).
  All 60 binary sizes and SHA-256 hashes match the public manifest/checksums.
  A later TC001 report shows an almost fully lit cyan/white panel despite fresh
  serial telemetry and a running display loop. A target-only reset reinitialized
  the LED matrix, but the user confirmed the all-on output persisted, including
  after installing the official CI image. A comparison build with FastLED 3.7.0
  restored readable glyphs (user-confirmed); the 3.10.7 driver selected by the
  floating dependency is implicated, though its precise defect is not isolated.
  **ESP32 1.9.2 is the patch candidate** for the exact driver pin, frame
  diagnostics and readable reset countdowns; it is not yet a published release.
  The release decision remains a patch from public 1.9.1: it repairs existing
  TC001 output and countdown usability, with no new compatibility milestone.
  The countdown retains its window label, removes `R` and scrolling, and holds
  each time reading for four seconds. Other channels do not change version.
  TC001 now runs the 1.9.2 candidate from `e53ab697`; after OTA and fresh boot
  telemetry, the user confirmed that time is readable and the center button
  holds the reading for at least 15 seconds and resumes cycling normally.
  The candidate SHA-256 is
  `1ac67eef00e965357749f250632b9388171f564dc936f04007d0c1fc7c2f12b7`.
  NM serial and T-Embed WiFi readbacks remain at 1.9.1; this patch does not
  change their display behavior.
  The [full-tier receipt](verification/receipts/2026-10-13-e53ab69.json)
  preserves one local TTGO framework-resolution failure; all other automated
  gates passed. pioarduino's cleanup removed the Arduino 3 package installed
  under a version-suffixed directory alongside Arduino 2. Restoring Arduino 3
  to the base package path fixed the build, and the
  [same-source TTGO retry](verification/receipts/2026-10-13-e53ab69-ttgo-retry.json)
  passed in 64 seconds. The original failed receipt is not relabeled as a pass.
  PR #531's complete CI matrix, including TTGO, also passes. Broad lab gates in
  the receipts remain unattested; the TC001 optical acceptance above is separate.

The [clean final full-tier receipt](verification/receipts/2026-10-13-cc0d21a.json)
passes in 14m11s and covers the bidirectional handover candidate; its tree matches
merge `88e31aa0`. Windows Node 22/24/26 and all Apple CI configurations pass. The
first Windows 26 hook check exceeded 10 seconds; the same-commit retry passed.
The earlier full tier at `d98ee6e` passed before PR #526 and does not attest the
later fix. Automated verification does not establish physical optical acceptance
or store publication.

### October 2026 correction

Android 1.10.0 has already been published to GitHub and internal Play and
submitted for production. Its main purpose was completing and polishing the
1.9 experience, so **1.9.1 would have been the appropriate classification**.
Keep the delivered 1.10.0 identity; the next fix-only Android release is 1.10.1,
not 1.11.0. The current unshipped Apple/npm/ESP32 1.10.0 and deck-plugin 1.9.0
manifest values must be classified against each channel's actual delivered
scope before their next upload/tag. Do not mechanically copy Android's number
or publish those candidates just to align the fleet. New substantial features
will receive a shared named minor milestone under the rules above.

Three portal facts worth keeping from the recent Android delivery:

- **Android developer verification covers apps you ship OUTSIDE Play too.** The Play release was blocked by "이 출시를 진행하려면 모든 키를 등록하여…" even though the Play app-signing key was registered. The missing key was the **upload key** (`10:60:3A:F8…`), which is what `scripts/build-android-release.sh` signs the GitHub APK with. Registering it cleared the error immediately. Diagnose by comparing the fingerprints on the app-signing page against the registered list — a package showing `등록됨` is not proof that every key it ships under is there. Deleting an unrelated stale package entry does **not** help; that was tried first and changed nothing.
- **Saving a Play release does NOT submit it.** With managed publishing disabled, the release still lands as `아직 검토를 위해 전송되지 않음` on the track's 출시 tab, and the publishing overview reads `변경사항이 아직 검토를 위해 제출되지 않음` with a `검토를 위해 변경사항 N개 제출` button that must be pressed. The track summary says `최신 출시 버전: 12 (1.0.10)` either way, so that line cannot distinguish saved from submitted — read the per-release status, and confirm the summary flips to `출시 버전 12 (1.0.10) 검토 중`. Checking the publishing overview immediately after saving is also unreliable: it reported no pending changes while the save was still settling.
- **Play's release-notes field silently drops every language but the first on each save.** All three (`en-US`, `ko-KR`, `ja-JP`) must be re-pasted immediately before the final save, and the "N개의 언어로 출시 노트 제공됨" counter is the only confirmation that they took.

Run `pnpm verify-version` before every build or release. CI rejects a compatibility-major split or a target-internal mismatch. Release CI additionally requires a channel tag's full `X.Y.Z` to equal that target's own declared version; it does not compare the tag's minor or patch with root `VERSION`.

## 1.8.0 preparation evidence — CI waits and outstanding acceptance

Preparation branch: `codex/release-ci-wait`, based on `b6fa21bf` (2026-10-05).
The six channel manifests and prepared changelog entry target backward-compatible
1.8.0; the root compatibility-major anchor remains 1.0.2. These historical preparation receipts do not prove publication.
The owner authorized distribution on 2026-10-06 after #460 merged as
`4168e57239b825c101c61b337c8602a8e3b748ec`; every 1.8.0 channel tag targets
that commit unless the channel-specific delivery readback records a follow-up. Current channel delivery is recorded in the
[delivery readback](#delivery-readback-2026-10-06).

The owner explicitly waived iPhone reinstall verification and physical deck
operation on 2026-10-06. Deck acceptance for this candidate uses code tests and
simulator scenarios; these waivers are not claims that hardware was tested.
The final deck acceptance uses production controllers and loopback WebSocket
peers on Classic (15 keys), XL (32), SD+ keypad (8) and D200H (14). Eight new
integration cases plus existing timeout/correlation tests pass (199 focused
checks); twenty production-renderer frames were inspected. Catalog paging,
stale-target refusals, explicit-default retry, BACK/late replies and observed
NOW/readout updates are covered. This is headless controller simulation, not an
official host/device simulator. The final full suite passes 5,423 tests (8 skipped),
with build/typecheck and protocol/token drift checks passing. Test-only additions
do not change the installed executable inputs.

| Work | Prepared 1.8.0 scope | Separate or external acceptance |
| --- | --- | --- |
| [#463](https://github.com/puritysb/AgentDeck/issues/463) deck settings | #464–#466: per-session model/effort/mode, OpenClaw setting pickers and observed NOW cards, with final-review corrections | Integrated in #460 with target binding, strict validation, correlated replies, bounded waits and visible errors; OpenCode steering remains separate; the owner accepts code/simulator verification instead of physical deck operation for 1.8.0 (2026-10-06) |
| [#433](https://github.com/puritysb/AgentDeck/issues/433) CI waits | Claude/Codex/OpenCode/Hermes lifecycle, explicit clearing, bounded Node evidence/counts, session-bound GitHub companion orbit/result cues, readable Canvas/native cues, firmware activity, foreground APME accounting | Physical fleet/phone acceptance remains distinct from source and fixture tests; unknown evidence never claims a provider verdict |
| [#449](https://github.com/puritysb/AgentDeck/issues/449) delivery | #451, #452, #459 plus clean installed-tarball acceptance, versioned plugin packages and unsigned Android artifacts | Distribution signing, upload, store review/publication and DRM-processed encoder acceptance are outside this preparation |
| [#423](https://github.com/puritysb/AgentDeck/issues/423) Hermes umbrella | Observer-only support retained; pinned upstream CLI callbacks and real read-only GitHub watcher captured | Remains open while child acceptance is incomplete |
| [#425](https://github.com/puritysb/AgentDeck/issues/425) Hermes surfaces | Actual macOS 3D, Lenovo Canvas/Filament CI rendering, iPad native rendering, crowded-profile and package tests | iPhone 14 Pro Max passed the prior appearance build; latest-candidate reinstall verification is explicitly waived by the owner (2026-10-06); physical matrix/firmware optical acceptance is not inferred from compiled images |
| [#426](https://github.com/puritysb/AgentDeck/issues/426) Hermes lifecycle | Pinned CLI tool/Stop/finalization, private CI intent, independent sessions and Swift model attribution | A test-only messaging Gateway channel and permission to send test messages are still needed for real `/new`/reset capture |
| [#428](https://github.com/puritysb/AgentDeck/issues/428) Hermes model | Existing renderer retained without claiming visual approval; no replacement asset is bundled | Replacement face/rig/export and owner visual acceptance remain a separate artwork task |
| [#273](https://github.com/puritysb/AgentDeck/issues/273) managed replacement | All managed contracts retained; no PTY removal in 1.8.0 | Remote relay/two-machine and terminal-only replacement gates apply to future removal work |
| [#272](https://github.com/puritysb/AgentDeck/issues/272) e-ink | Existing readable CI activity retained | Repaint/optical measurements, audio hardware and Swift pull-path decisions remain research; no redesign is claimed |

Candidate checks include
`pnpm test:packaged --soak-seconds 60 --keep-artifacts --report diagnostics/release-180/packaged-daemon.json`. It packs all four npm
packages, installs them outside the workspace and proves native bindings,
installed hooks, failed-to-repaired CI evidence, twelve independent conversations,
compact device frames, reconnects, soak health and restart persistence. Its GitHub
responses are fixtures; the separate pinned Hermes CLI receipt uses a real `gh`
watch against completed PR CI, with a deterministic local model provider.
Neither receipt proves a messaging-platform Gateway session. The installed 1.8.0
CLI also passed Swift-to-Node takeover, Node-only operation, app relaunch as a
Node client and automatic Swift recovery on an isolated port, with production
listeners unchanged.

Native QA found and fixed canceled asset loads being shown as permanent failure,
macOS selectable Timeline text flipping over the Metal scene, stale sibling
frames overriding permission priority, and missing Hermes model attribution in
Swift runs/turns/tasks. Accepted CI timeline annotations now broadcast live,
while deduplicated rows stay suppressed. Explicit QA data directories no longer import the real
daemon registry or credentials. CLI lifecycle commands also verify installed
service data scope before controlling launchd/systemd/Scheduled Task units. Device QA uses development execution only; it
is not distribution signing or App Store sandbox acceptance. The superseded
station candidate compiled all twelve firmware targets and packaged 62 assets.
Its IPS10 image had 68,544 bytes of app-partition headroom; that receipt is
superseded. The final appearance/orbit candidate passed all twelve board builds
and packaged 62 files. Six targets were rebuilt for the TTGO memo change; actual
compiler dependencies prove the six retained outputs had unchanged inputs.
All merged headers, artifact hashes and partition bounds passed. The final padded
IPS10 application uses 6,225,408 of 6,291,456 bytes, leaving 66,048 bytes (98.95%
used). Per-board source stamps and compiler-input receipts retain this distinction.

The current appearance pass distinguishes Claude’s black eyes, OpenClaw’s black
eyes and original teal pupils, Codex’s filled white prompt and OpenCode’s actual central
opening. It covers both 2D and 3D rendering, including generated device glyphs
and canonical terminal cells. Very small LED/terminal samples can average away
fine details; terminal hues require true-color support.
The prior candidate `41803e5c` passed all ten GitHub checks, 5,363 Vitest tests,
473 Android tests and 82 focused Swift tests. The integrated #463 stack and final
Ulanzi pagination correction are now executable candidate `9d0ccf2c` (all ten
GitHub checks pass): build and
typecheck pass, with 5,415 Vitest tests (8 skipped), 14 real-daemon E2E tests and
16 focused Swift tests. Protocol, generated settings rules, tokens and design
lint remain in sync. Android and ESP32 tracked sources and all 225 measured
firmware compiler inputs are unchanged, so their prior artifact receipts remain
applicable. Fresh macOS/iOS archives pass invariant checks; four clean-installed npm
tarballs pass all ten acceptance checks and a 60-second soak. Affected runtime
installations are recorded separately below.
Archive invariant checks use local verification signatures only; no distribution
signing or store delivery is part of this preparation.

The final fixes include #462/#461 Timeline grouping and Android recency/selection,
natural Android HUD leading, resolved npm dependency build identity, and bounded
Codex subagent filtering in Node and Swift. Re-running the previously misclassified
child did not recreate the phantom project. These are candidate/runtime receipts,
not public deployment evidence.

TTGO's CI memo preserves ten owners in 160 bytes rather than 240, fixing the
48-byte static DRAM overflow. The linked image has only 32 bytes of static
region slack; that is not runtime heap headroom. The installed board observed
69–72 KB internal free heap and a 37 KB largest block over 63 seconds without
reboot. Longer performance and physical panel/touch acceptance remain separate.

The local delivery inventory is `dist/RELEASE-1.8.0-PREFLIGHT.txt`; the matching
hash manifest is `dist/RELEASE-1.8.0-ARTIFACTS.json`. It identifies 75 current
artifact records, including 62 firmware files and both current archive trees.
Use `apple-1.8.0-pr463-final/` for Apple source verification; the preserved
`apple-1.8.0-preflight/` archives are superseded.

Previously built archives/packages are superseded wherever their inputs change.
The deployment audit separately records source changes, package contents and
installed/runtime identity for ESP32, Stream Deck and D200H; compilation alone
does not update a connected device.

The completed local deployment audit on 2026-10-06 records the following.
These are local test-fleet installations, not public release versions:

| Target | Verified candidate installation | Remaining boundary |
| --- | --- | --- |
| Node daemon | Four fresh 1.8.0 npm packages; restarted runtime content identity `f698eb52c5e1`; real target-bound catalog query succeeds without broadcasting to other clients | No npm publication or release tag |
| Apple | Fresh #463 macOS 1.8.0/build 5 and iPad Air M2 app installed/launched; both new Release archives pass invariant checks | iPhone 14 Pro Max retains the prior 1.8.0 candidate; the owner waived latest-candidate reinstall verification on 2026-10-06, so it is not a release-preparation blocker. Distribution signing/store delivery excluded |
| Android | Lenovo and Crema 1.8.0/code 25 installed in place with final Timeline/typography fixes | Pantone unavailable; Play upload excluded |
| ESP32 | All eleven connected ESP32/TC001 boards updated; twelve-target artifacts prepared | C6 unavailable; final 225 firmware inputs unchanged, so later fixes need no reflash |
| Stream Deck | 1.8.0.0 rebuilt with #463, installed and restarted; loaded runtime hash matches validated package | Physical button-operation acceptance is waived in favor of code/simulator checks; DRM-processed artifact review remains a later marketplace step |
| D200H | Ulanzi 1.8.0 rebuilt with #463 and later-page refusal fix; WASM/fonts validated, installed and restarted | Fresh process launches matching installed bytes; no in-process hash attestation. Code/simulator acceptance replaces physical deck operation for this release; long-term hardware-link behavior remains unmeasured |

A retained Stream Deck host preview showed an old extra Codex row even though
the live daemon roster contained four expected rows. Restarting the host cleared
that image and restored matching live usage values; no source regression was
confirmed.

User data and device preferences were preserved. Five USB firmware updates also
verified identical NVS before and after installation. The local receipts are
kept under `diagnostics/release-463-integration/`, `diagnostics/pr463-integration/`,
`diagnostics/pr462-fix/` and `diagnostics/release-180/`; private captures
and credentials are not public release media.

D200H uses the Studio plugin; TC001 uses ESP32 firmware. Pixoo, Timebox and
iDotMatrix receive daemon-rendered pixels and use the updated Node/Swift renderer.
The public web flasher still selects ESP32 1.7.0; update it to the eventual 1.8.0
manifest and images only after publication. Existing public 1.7 delivery and local
1.8 candidate installation must be reported separately.

Existing aquarium/key gallery images depict the prior creature treatment.
Representative final synthetic-session native captures and generated deck-key
assets are prepared separately for release media review. Preserve unchanged
setup/pairing and real hardware-shell photographs; historical screenshots are
not proof of the 1.8.0 appearance, and generated key assets are not device photos.
The live preview uses canonical renderer frames, including terminal background
colors and exact half cells, with explicit placeholders if frame data is absent.
The earlier 39-image store gallery and aquarium movie/GIF are historical media,
not proof of current 1.8.0 appearance. The new 36-second native iPad introduction
and three full-frame screenshots show fictional Hermes and GitHub CI scenarios.
Twelve localized supplement images (English/Korean/Japanese; two iPad and two
Mac views per locale) use verified native captures. The iPad views show Hermes
and GitHub CI; the earlier Mac QA views show four agents with permission/unknown
CI context, without Hermes. Source and channel limits must be followed when
selecting submission images; see the
[media readiness manifest](apple/appstore-submission/media-1.8.0-readiness.json).
The failed new iPhone
captures are excluded, and no complete recapture of every store gallery is claimed.

Other follow-ups: IPS10 wake-word 3-to-5-frame candidate needs a new controlled
false-positive/missed-trigger/latency comparison before firmware inclusion;
GitHub removal of historical exposed PR artifacts remains an external cleanup
request after credential incident containment. Neither historical installation
state nor a passing source test is a fresh runtime receipt.

Unavailable hardware does not hold unrelated channels. A confirmed regression
holds the affected artifact. Missing visual approval does not authorize replacing
the Hermes model. Record source, artifact, upload, submission and public state
separately; the existing public 1.7 builds do not contain later source changes.

## A release has five states, and only one of them is "released"

CI going green is the first of five, not the last. Keep them apart in your head and in anything you write down:

1. **CI succeeded** — the workflow exited 0. This alone still proves only the workflow, not the destination. Before 2026-08-10 npm publishing was gated on an unset variable, so two tags produced green runs and published nothing; the current workflow makes publishing mandatory and verifies the registry before creating the GitHub Release.
2. **Artifact exists** — a GitHub Release carries the APK / `.streamDeckPlugin` / firmware.
3. **Uploaded to the store** — the binary reached ASC / Play / a marketplace portal. Nobody outside can install it yet.
4. **Submitted for review** — a human pressed a button in a portal. No tag, no workflow, and no repository artifact records this.
5. **Live** — the store distributes it.

**Never report a state you did not measure.** Each has its own instrument: the workflow log for 1, `gh release list` for 2, the portal or `npm view <pkg> version` for 3, and the portal for 4 and 5. Deriving one from another is how "released" gets claimed for a build sitting in a portal — it happened on 2026-08-09, when CI upload was reported as a completed Stream Deck and Ulanzi release while neither had been submitted.

### Android 1.10.0 delivery readback, 2026-10-13

[PR #524](https://github.com/puritysb/AgentDeck/pull/524) merged after all CI
checks passed. The clean implementation at `31b7c06b` passed
[`verify:full --record`](verification/receipts/2026-10-12-31b7c06.json) in
14m43s, including 501 Android tests and the Store/Dot artifact boundaries.
`android-v1.10.0` points to `a7fc56d2` (the implementation plus documentation
and the verification receipt). No other channel tag was pushed in this delivery.

| Channel / device | Verified state |
| --- | --- |
| GitHub Android | Signed 1.10.0 APK public; downloaded version/signature/SHA-256 verified |
| Play internal | 27 (1.10.0) available; enrolled Lenovo installed the actual Play update |
| Play production | 27 (1.10.0) submitted for full rollout; overview says Changes in review; approval publishes automatically |
| Lenovo | Play installer and Google signing certificate verified; 3D view and USB connection retained after 1.9 → 1.10 update |
| Crema / Pantone | Public GitHub APK upgraded in place; live static background counts verified |

On Lenovo at thermal status 3, the Play build's native SurfaceView presented
29.620 FPS with eight sessions / twelve jobs each (733 frames, zero drops).
The startup-inclusive live sample was 29.806 FPS (707 frames, two drops).
After restoration to the real host and warm-up, the Play build presented
30.269 FPS / 749 frames / zero drops.
Earlier signed-candidate samples were 30.176 FPS live and 29.855 FPS crowded,
both with zero drops; the pre-fix baseline was 13.238 FPS. These measurements
prove the thermally constrained 30 Hz path, not unthrottled 60 FPS parity.
Artifact hashes and store state are recorded in the
[Play receipt](marketplace/play/LISTING.md#1100-submitted-2026-10-13).

### Additional 1.9.0 delivery readback, 2026-10-12

The owner authorized the additional channels and Android onboarding audit.
[PR #514](https://github.com/puritysb/AgentDeck/pull/514) adds appearance,
computer connection and readiness steps shared by LCD and e-ink, with a real
empty-habitat preview, skipping, persistent completion and Settings re-entry.
Upgrades retain existing settings and paired hosts. Pairing codes require an
unambiguous or explicitly selected host.

| Channel | Verified destination | Source |
|---|---|---|
| Android | Google Play **26 (1.9.0)** available, published October 12 at **13:10 KST**, 100% rollout across 178 countries/regions; signed GitHub APK public | `android-v1.9.0` → `79061799` |
| ESP32 | Twelve-board release with 62 assets; all 60 binaries match manifest sizes and SHA-256 values | `esp32-v1.9.0` → `79061799` |
| npm | All four public packages and `latest` tags read back as 1.9.0; registry integrity and nonempty setup README verified | `npm-v1.9.0` → `8869a73e` |

The downloaded public Android APK's SHA-256 is
`f3f2cab17f11f2f79f492d1d10493768ee27956e14ffb1c42e06282d0faa8632`;
its signing certificate matches the established release identity. That exact
APK is installed on Lenovo Tab, Crema S and Pantone 6, with settings and guide
completion preserved. LCD and e-ink onboarding were exercised, including
explicit-host pairing and Wi-Fi reconnect. Three release-note languages remain
attached in Play, with unchanged supported-device coverage.

Official ESP32 CI images installed on LilyGo EPD47 and T-Display-S3-Pro both
passed write verification and directly reported **1.9.0 / 79061799** after boot.
All 15 downloaded CI binaries match their final public counterparts. This is a
boot/transport receipt, not a claim of full physical visual or touch coverage.
NM-EPD-420 returned no fresh serial identity; it was not flashed. Its connection
recovery and update are tracked in [#518](https://github.com/puritysb/AgentDeck/issues/518).
The Pages flasher deployment is tracked in [#515](https://github.com/puritysb/AgentDeck/issues/515).
Flash geometry is unchanged from 1.8.0, so the Pages refresh and npm publication
overlap after the complete firmware release becomes public.

[PR #516](https://github.com/puritysb/AgentDeck/pull/516) repairs repeated APME
startup backfills and synchronous macOS display polling. The npm tag's tree is
identical to merge `4f00b28f`; its [clean full receipt](verification/receipts/2026-10-12-8869a73.json)
records **25 automated passes in 15m16s**, with Windows Node 22/24/26 covered
by hosted CI. The three broad manual lab gates remain unattested. The published
packages' **1297 code, type and asset files** byte-match the installed candidate.

Installed build `ee3f46e3890b` answered **90/90** health probes under concurrent
full build load (median **4 ms**, maximum **1,810 ms**, 5 s deadline). Real work
reached tablets and the Mac in CLI-only and Node-owner/Mac-client modes. After
CLI shutdown, TestFlight 7901 reclaimed 9120 in **145.2 s**, including the macOS
bind cooldown on 9121; all three tablets displayed the subsequent real Swift
reply without hook reinstallation or ADB repair. Swift-only Timebox/iDotMatrix
powered-on timeouts remain [#517](https://github.com/puritysb/AgentDeck/issues/517).
Those BLE sources are unchanged from Apple 1.8.0, so a new regression is not
established. The Swift APME follow-up is not in immutable submitted build 7901.

[Local main deployment](https://github.com/puritysb/AgentDeck/actions/runs/38205823630)
was restored at `4f00b28f`: installed Mac app, supervised daemon with the measured
build identity, and Stream Deck runtime verified. The older staged app was
preserved in diagnostics/backups before retry, and the CLI was relinked to the
persistent main checkout after installed-package acceptance. Stream Deck and
Ulanzi have no new release in this round. The release workflows are
[Android](https://github.com/puritysb/AgentDeck/actions/runs/38201953480),
[ESP32](https://github.com/puritysb/AgentDeck/actions/runs/38202033639) and
[npm](https://github.com/puritysb/AgentDeck/actions/runs/38206633050).

### Hardware recovery acceptance, 2026-10-12 evening

After the user unlocked the Mac, power-cycled Timebox and reconnected NM USB,
the two outstanding hardware checks were repeated. Actual TestFlight **1.9.0
(7901)** reported `allowedAlways` / `poweredOn`; Timebox and iDotMatrix both
connected and completed new frame uploads. Swift first served on 9121, then
reclaimed 9120 after the existing bind cooldown and reconnected both displays.
The reverse Swift → Node handoff also completed with both displays connected,
fresh upload timestamps and no BLE errors. No privacy grant or BLE identity was
changed by the agent. This resolves [#517](https://github.com/puritysb/AgentDeck/issues/517).

NM answered a fresh leased serial identity probe as `nm_epd_420` before the
official `esp32-v1.9.0` merged image was written. The supported CLI passed chip /
flash preflight, verified the write, and read back **1.9.0 / 79061799** after
boot. A bounded serial `display_state` off/on exercise remained responsive.
After restoring the daemon feed, a direct read without toggling USB control
lines reported 8 sessions, 12 timeline entries and 3 completed panel refreshes.
This resolves [#518](https://github.com/puritysb/AgentDeck/issues/518). The exercise
proves protocol recovery and completed panel I/O, not photographic color quality,
button coverage or a full Mac suspend/resume qualification. The three broad
manual lab gates remain unattested.

The normal supervised Node owner (`ee3f46e3890b`) and development Mac app client
were restored, with the serial lease released. This acceptance uses the existing
TestFlight build; it does not add the later APME/permission-diagnostic changes to
immutable submitted Apple build 7901 or claim a new Store submission.

### Apple 1.9.0 delivery readback, 2026-10-12

[PR #512](https://github.com/puritysb/AgentDeck/pull/512) merged as
`105cca546266a087774f058628875ed73b854f74`; `apple-v1.9.0` points to that commit.
The [distribution workflow](https://github.com/puritysb/AgentDeck/actions/runs/38191573875)
passed both signed exports, both App Store archive/Dot-exclusion checks and both
uploads. The [GitHub release](https://github.com/puritysb/AgentDeck/releases/tag/apple-v1.9.0)
exists with CHANGELOG-rendered notes.

The following values were read independently from each platform in App Store
Connect, then confirmed in its App Review submission list:

| Platform | Version / build | Submitted (KST) | Verified state |
| --- | --- | --- | --- |
| iOS | 1.9.0 / 7901 | October 12, 10:35 | Waiting for Review |
| macOS | 1.9.0 / 7901 | October 12, 10:44 | Waiting for Review |

Both retain automatic release after approval, immediate rollout to all users and
existing ratings. Approval and public availability are **not** claimed; 1.8.0
remains the last verified live Store version. English/Korean/Japanese release
copy and the platform-specific review notes were saved before submission.

The merge also passed the owner's local-main deployment. The installed, running
Mac development app reports 1.9.0/build 5 and passes the compiled Dot-exclusion
check. That local build is distinct from the submitted distribution build 7901;
it does not replace the outstanding physical iPad or live Swift/Codex acceptance.
Other delivery channels were not republished.

### Apple 1.9.0 candidate audit, 2026-10-12

At the initial audit, App Store Connect listed both iOS and macOS **1.8.0 as
Ready for Distribution**. The subsequent 1.9.0 delivery is recorded above.

The candidate includes first-use setup and pairing recovery (#492, #494, #503),
session attribution and duplicate-event fixes (#490, #500, #504, #505), background
work tracking and orbiting companions (#507, #510, #511), and native pixel-display
improvements. Dot is excluded from both Store artifacts; preview development is
retained. Other delivery channels keep their existing versions.

No open PR remained at the initial audit. Master `15b6dc5e` had successful Apple,
main CI, design, Pages and local-deploy workflows. Open issues #423/#425/#426/#428
retain Hermes messaging-platform, physical-device and replacement-model acceptance;
#463 retains further deck-control capabilities and physical acceptance. These are
not newly completed capabilities of 1.9.0. #272/#273 remain research/migration work,
and #449 is the preceding multi-channel delivery tracker. This candidate does not
claim replacement-model approval, new Hermes messaging support or new deck switches.

The full local run at `76b06c4b` passed Store/preview native builds and tests,
coverage, daemon E2E, Android and ESP32 checks. Its retained receipt records a
packaged-daemon assertion failure: the captured Hermes fixture has three explicit
cancelled Stops **plus** an open turn closed by SessionEnd, while the script
incorrectly required exactly three Interrupted rows across all sessions. A second
isolated replay reproduced all four correct closures. The assertion now checks
each explicitly cancelled session independently. The scoped
`pnpm verify:full --only npm-packaged --record` rerun at `d12e9fd9` passed all ten
package checks, including 60-second health/JSON soak and isolated restart. Keep
the [original full receipt](verification/receipts/2026-10-12-76b06c4.json) and
[package rerun receipt](verification/receipts/2026-10-12-d12e9fd.json) together:
the latter is partial verification, not a replacement claim for the full run.
Final quick and changed-area checks passed; the Apple source is unchanged since
the recorded native run.

Five native first-use page captures were inspected. An iPad Air Release candidate
was built, passed the Dot-exclusion artifact check and installed; launch was
refused while the device was locked. This is not physical runtime acceptance.
The Windows Node 22/24/26 checks passed in hosted PR CI; they were not run on this
Mac. Hardware, live Swift/Codex and replacement-model acceptance remain separate.

Both 1.9.0 App Store Connect drafts have saved English, Korean and Japanese
What's New/promotional text and platform-specific review notes. English pairing
copy now states network reachability, rather than implying QR bypasses subnet
reachability. Metadata preparation is not an upload or review submission.

### Delivery readback, 2026-10-06

All six channels target **1.8.0**, from #460's merge commit
`4168e57239b825c101c61b337c8602a8e3b748ec`. ESP32 uses the firmware-only
follow-up `1940f44eb5a91836e2ec81c02b14c2f38e57164b` (#468). Distribution is authorized;
store submission and public availability remain distinct.

| Channel | Verified delivery state | Remaining external step |
| --- | --- | --- |
| Apple | Distribution CI and both uploads passed; iOS and macOS 7801 are Waiting for Review | Platform review/automatic publication |
| Android | Signed GitHub APK and Play 25 (1.8.0) public; full rollout across 178 countries/regions, published October 6 at 14:52 KST | None for publication |
| Stream Deck | Official CI package public on GitHub; Elgato 1.8 (package 1.8.0.0, SDK 3, DRM enabled) went Pending review on 2026-10-06 after the owner-authorized deletion of pending 1.7, and the public Marketplace page shows Version 1.8 released 2026-10-08 (read 2026-10-11) | None for publication; whether DRM-processed encoder acceptance ran before the manual publish is not recorded |
| Ulanzi | 1.8.0 submitted and portal readback verified; GitHub package public | Store review; last verified public version 1.6.0 |
| ESP32 | Twelve-board release public with 62 assets; all 60 binaries match manifest/checksum sizes and SHA-256 values; Pages selects 1.8.0 and all five offered merged images match | None for publication; no additional physical reflashes claimed |
| npm | All four packages public at 1.8.0; all `latest` tags and nonempty setup registry README verified; release CI passed | None for publication |

The first ESP32 release run `37416793515` failed TTGO linking with 152 bytes
of static DRAM overflow. Fresh range resolution selected LVGL 9.6.0 and
LovyanGFX 1.2.32 instead of TTGO's validated 9.5.0/1.2.21. #468 pins all five
TTGO libraries to their measured versions and adds a fresh Linux TTGO PR compile
gate. Clean local and Linux links pass; prior 32-byte linker slack is restored,
not a claim of runtime heap margin. No firmware had been published, so the
unpublished `esp32-v1.8.0` tag was moved from `4168e572` to `1940f44e` with an
explicit expected-old-reference lease. The original failed run remains available;
replacement run `37422033801` passed all twelve board builds and publication;
its 62 public assets include the manifest, checksum list and 60 verified binaries. Other channels'
already submitted binaries are unchanged.

npm publication runs alongside the firmware retry. The board geometry SSOT is
byte-identical between `esp32-v1.7.0` and npm's `4168e572` source, so the existing
public manifest remains compatible. This round has no flash-size migration that
would make firmware-first ordering mandatory; the web flasher still advances
only after the new firmware manifest and merged images are public.

Pages run `37422008719`, attempt 2 at `1940f44e`, passed after firmware publication.
The public `/flash/fw/index.json` selects `esp32-v1.8.0`; its manifest is
byte-identical to the release manifest. All five offered merged images were
read back from public same-origin URLs and match their expected sizes/hashes.
This verifies public delivery, separately from earlier local device installations.

Production port 9120 acceptance uses the installed Node build `f698eb52c5e1`
and macOS 1.8.0/build 5 development candidate. Real direct Claude turns reached
the Mac timeline and downstream WebSocket frames in CLI-only, Swift-only and
coexistence modes. On supported CLI stop, Swift automatically recovered 9120
in about 169 seconds after fallback to 9121 and its existing 120-second
failed-bind memory; no hook reinstall or manual port repair was needed.
The separate #451 reverse-order check kept Mac open: supported CLI start
acquired 9120 as Node in 35.789 seconds, and a new completed turn appeared in
the Mac timeline. Exactly one canonical listener remained. The original
Node-owner/Mac-client configuration was restored. This local runtime receipt
does not claim that the submitted App Store build was installed. All four public
npm tarballs pass registry SHA-512 integrity verification; their 295 runtime
JavaScript files and package manifests match the installed candidate exactly.

The official Stream Deck CI package's SHA-256 is
`ec0814da259c8ce8dbecb11d60e23299d84dbe8ad87cf537514db32c1daa3575`;
its embedded runtime is byte-identical to the tested installed runtime.
Ulanzi's local submitted ZIP and public CI ZIP differ only in build-path labels
inside `app.js` and archive metadata; normalizing those labels produces identical
JavaScript. Seven localized listings and D200/D200H/D200X keypad scope were
preserved; Dial/AU05 and encoder support are not claimed.

### Store readback, 2026-10-05

- **Apple iOS and macOS 1.7.0 (7701) are public.** App Store Connect reports
  Ready for Distribution for each platform, with automatic release selected.
  The [public Mac page](https://apps.apple.com/us/app/agentdeck-dashboard/id6784822497?platform=mac)
  serves Version 1.7.0 and its Mac-specific release notes. Apple's iOS lookup
  reports 1.7.0 in both US and KR, released `2026-10-04T16:52:31Z`.
  Existing preview videos and screenshot galleries remain attached to both
  approved platform records; no replacement build or resubmission was needed.
- **Google Play 24 (1.7.0) is available.** The production release row says
  Available on Google Play, published October 4 at 09:34 in the console.
  The [public listing](https://play.google.com/store/apps/details?id=dev.agentdeck&hl=en)
  serves the Hermes/credits/session-ordering notes and an October 4 update date.
  The public Crema pair and four tablet images visually match the retained
  submission files in `marketplace/play/1.6.1/`; the gallery acceptance in
  #449 is complete. This is a visual comparison, not a byte-identity claim.
- **Elgato 1.7 remains Pending review; Ulanzi 1.7.0 remains under review.**
  Their last measured public versions remain 1.6 and 1.6.0 respectively.
  Elgato still needs DRM-processed encoder acceptance after approval and before
  publication. The remaining store and community hardware gates live in
  [#449](https://github.com/puritysb/AgentDeck/issues/449).

This readback concerns the existing 1.7 deliveries. Later fixes merged in
#451–#455 require future versioned artifacts; they are not included merely
because 1.7 is now public.

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

**Push release tags one at a time, never in one batch.** GitHub creates no
workflow event for a push carrying more than three tags — documented behavior,
measured here on 2026-09-02: all six `*-v1.2.0` tags pushed in one command
landed on the remote and fired **zero** release workflows, silently. Nothing
was red; the newest run of every release workflow was simply last month's. The
recovery is to delete the remote tags and re-push each one in its own
`git push origin <tag>` — re-pushing an *existing* tag fires nothing, so the
delete is required, and it is safe exactly while no run has consumed the tag
(check `gh run list --workflow=<wf>` first). A coordinated round is six pushes,
not one.

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

## Shared major, aligned milestones and independent delivery

| Surface                                                   | Target version                               | Independent monotonic value                                                | Tag / delivery                             |
| --------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| **Apple** (iOS+macOS)                                     | `apple/project.yml` `MARKETING_VERSION`      | `CURRENT_PROJECT_VERSION` (CI-owned)                                       | `apple-v*` → TestFlight / App Store        |
| **Android**                                               | `android/app/build.gradle.kts` `versionName` | `versionCode` (candidate 25; public 1.7.0 used 24)                                               | `android-v*` → APK Release / optional Play |
| **npm** (`@agentdeck/hooks`, `shared`, `bridge`, `setup`) | public `package.json` files                  | npm registry version floor                                                 | `npm-v*` → OIDC publish                  |
| **ESP32**                                                 | `esp32/src/config.h` `FIRMWARE_VERSION`      | build hash / epoch in firmware metadata                                    | `esp32-v*` → firmware Release              |
| **Stream Deck**                                           | plugin manifest `Version` as `X.Y.Z.0`       | fourth component if a same-product-version plugin rebuild is ever required | `streamdeck-v*` → Elgato Maker portal      |
| **Ulanzi**                                                | Ulanzi manifest `Version`                    | marketplace submission record                                              | `ulanzi-v*` → Ulanzi Studio Marketplace    |
| **Private JS workspaces**                                 | their `package.json` files                   | not published                                                              | no independent delivery                    |

Tag prefixes remain because channels ship independently and may point to different commits. A minor or patch bump updates only the target being delivered. A channel is considered shipped only when its prefixed tag and external release/submission exist. Do not claim an unsubmitted marketplace artifact as released merely because another target advanced.

## Version rules

1. All targets must share root `VERSION`'s major. Changing it is a coordinated compatibility release.
2. Minor milestones follow the product-wide allocation above; patch versions and delivery timing may differ by target. `A.B.C` and `A.D.E` are mutually compatible for any numeric `B`–`E`; bump only the target being delivered.
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

1. Choose the next SemVer for the target, preserving the shared compatibility major. Apply the classification and decision record above: minor for a named new product capability, patch for completing or improving an existing capability.
2. Update that target's internal mirrors. Do not bump unrelated targets merely to align minor or patch values.
3. Increment Android `versionCode` when releasing Android. Apple CI owns `CURRENT_PROJECT_VERSION` (run number × 100 + attempt); its source value is a local default.
4. **Write the `CHANGELOG.md` entry, and the delivery table in `README.md`.** The
   changelog is not a courtesy copy — `scripts/release-notes.mjs` renders the
   GitHub Release body from it, so an unwritten entry is a release page with an
   install blurb where its notes should be. Heading format is
   `## <YYYY-MM-DD> — <Channel> <version>`; list every channel in one heading
   when a round is cut across several, which is what a simultaneous cut is.
   Verify before tagging: `pnpm verify-release-version <target> <X.Y.Z>`.
5. Run `pnpm verify:full --record` (the pre-release verification tier; attest the lab gates you ran with `--attest`), commit the receipt it writes under `verification/receipts/`, and confirm the relevant platform workflows are green.
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
   **If the run is red at `Publish packages` with `registry verification failed`, read the log before touching the tag.** The read-back after publishing is bounded (12 × 5 s); on 1.3.1 every package had been published within 25 s and `@agentdeck/shared@1.3.1` was still not visible to `npm view` 84 s after its publish started, so the first attempt exited 1 with nothing left to publish. The fix is **re-run the failed job**: `publish-npm.mjs` skips versions already on the registry, so the rerun only verifies, renders notes, and creates the GitHub Release. Do not delete and re-push the tag and do not bump the version — the version is already immutable on npm and a re-tag is a publish attempt that fails its first gate (see *A release has five states* above).

**A successful upload can remain unavailable while npm scans it.** On 2026-09-21,
all four 1.4.0 uploads were accepted, but a retry while `bridge` was still being
processed returned `E409 Cannot publish over previously staged version`.
That response is not permission to replace the tag, unpublish, or bump versions.
Wait for each exact version to become readable before rerunning the failed job;
already visible packages are skipped. `npm stage list <package> --json` can
distinguish an explicit maintainer-approval queue from an empty queue, but an
empty queue does not prove public availability. npm's [publish-time scanning
notice](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/)
describes typical delays around five minutes, sometimes 15 minutes or longer.
Record a held/blocked notification separately if one appears; do not label a
package live just because `npm publish` returned success.

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

`scripts/publish-npm.mjs` is retry-safe across a partial four-package delivery: an exact immutable version already visible on npm is skipped, the missing packages continue in dependency order, and every package is verified again at the end. This does not make the registry optional — a tag is complete only when all four exact versions are readable there. The same skip path is what makes a rerun after a registry-propagation timeout safe (1.3.1, 2026-09-12); the visibility window lives in `scripts/npm-registry-visibility.mjs` and is deliberately short so a genuine auth or trust failure still turns red quickly — widen it only if the propagation timeout recurs or a rerun also misses the window.

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

`1.0.8` (build 5301) went live on both platforms on 2026-08-22. `1.2.0` (build 5801, one submission per platform on 2026-09-02) **split again, this time on outcome rather than timing**: iPhone/iPad was approved and released the same day (lookup API: `1.2.0`, `2026-09-02T07:12:52Z`), while macOS was rejected under 2.3.10 (What's New named Android) and 5.2.5 (proof of the WeatherKit mark on a physical Mac — see the WeatherKit bullet under *Identity and signing* for the root cause, which was account state, not the binary). Both were fixed without a new build; the version was resubmitted on 2026-09-03 (`심사 대기 중` → `심사 중` on 2026-09-04) and **macOS 1.2.0 was approved and released on 2026-09-04** — the public Mac page read `Version 1.2.0 · 5h ago` at 2026-09-05T01:41Z, two days after the iPhone page's own 1.2.0 date, so the same build's two platform release dates differ by two days and a per-platform read is again the only honest one. **A Resolution Center reply does not resubmit.** After a metadata-only rejection the submission stays at `해결되지 않은 문제` until the version page's `심사 업데이트` is pressed (the item flips to `심사 준비됨`) and then `앱 심사에 다시 제출` on the submission page — that second button is disabled until the first is pressed, which reads as "nothing to press".

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
2. Run the Release build and App Store archive verifier described in `AGENTS.md`.
3. For a coordinated iOS + macOS delivery, tag and push `apple-v<APPLE_VERSION>`; CI archives and uploads both to TestFlight. For a macOS-only delivery, dispatch `apple-release.yml` on the reviewed commit with `release_version=<APPLE_VERSION>`, `platform=macos`, and `upload=false` to prepare the signed candidate. Use `upload=true` only for the authorized App Store Connect delivery. A manual run does not publish a GitHub Release; do not push an Apple tag for a single-platform delivery because tags still build and upload both platforms.

CI owns `CURRENT_PROJECT_VERSION` — `apple-release.yml` injects `github.run_number * 100 + github.run_attempt` into both archive steps, so the build number rises on every run and ASC never sees a duplicate `(version, build)` pair. Do not bump it by hand; the value in `apple/project.yml` is only a local-build default.

#### Dot development and Store builds

Both Apple targets use one source tree. Standard `Debug` and `Release` configurations
exclude Dot entirely; the default `AgentDeck_macOS` / `AgentDeck_iOS` schemes archive
`Release`. `AGENTDECK_APP_STORE` remains the macOS safety invariant in every configuration,
including previews; it is not a feature switch and never licenses a helper/subprocess.

| Configuration | Dot | Purpose |
|---|---|---|
| `Debug` / `Release` | Excluded | Normal development / App Store candidate |
| `DotPreviewDebug` / `DotPreviewRelease` | Compiled in | Explicit local Dot development, including optimized verification |

Select `AgentDeck_DotPreview_macOS` or `AgentDeck_DotPreview_iOS` in Xcode for Dot work.
They use the same targets, sandbox rules and bundle identity; these are development
configurations, not a second distributed app. Installing a preview can replace the
ordinary local app, so use isolated verification output rather than installing it
alongside the Store app. No Cloudflare backend is created by these configurations.

`apple/project.yml` owns `AGENTDECK_DOT_CONDITION`, `AGENTDECK_DOT_SUPPORT` and source/resource
exclusions. Only preview configurations define `AGENTDECK_DOT_PREVIEW`; default builds
exclude `Dot*.swift` and `dot-mcp-contract.json`. Dot integration boundaries in shared
Swift files compile conditionally. Incoming Dot fields from an external daemon are
ignored by Store clients; the Store daemon emits `dot: null` to clear old companion
state. Old Dot configuration/Keychain data is neither read nor resumed by that build.

Keep new native Dot code (including a future Cloudflare client) in `Dot*.swift` files,
with call sites behind `AGENTDECK_DOT_PREVIEW`. Add any new Dot-only resources to the
same exclusion and artifact check. Do not enable Dot through remote configuration,
UserDefaults, environment variables or a hidden menu in a Store artifact.

```bash
# Run from the repository root. Unsigned builds stay in apple/build/verification/.
bash apple/scripts/verify-build.sh macOS Debug
bash apple/scripts/verify-build.sh macOS Release
bash apple/scripts/verify-build.sh macOS DotPreviewRelease
bash apple/scripts/verify-build.sh iOS Release
bash apple/scripts/verify-build.sh iOS DotPreviewRelease
```

`pnpm verify:changed` selects these native checks for Apple changes. Apple CI tests
Store and preview macOS builds, builds macOS Release, and builds both optimized iOS variants. Each app is
checked by `apple/scripts/verify-dot-build.py`: build identity, compiled Dot markers
(including Xcode's Debug dylib), and the MCP resource must match the selected variant.
The release archive verifier always requires **excluded**, so a preview archive cannot
pass the upload gate even if it has valid distribution signing. Release commands also
pin `-configuration Release`. Enabling Dot for public distribution requires an explicit
source/configuration change, complete acceptance and a newly reviewed app release.

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
- **WeatherKit is enabled on the App ID in TWO places, and the entitlement proves only one of them.** In the developer portal, `bound.serendipity.agent.deck` carries WeatherKit under **Capabilities** (what the provisioning profile and the `com.apple.developer.weatherkit` entitlement reflect) and, separately, under **App Services** (what actually authorizes the JWT the framework mints at request time). With only the first, every build — dev or App Store, entitlement present, profile correct — has `WeatherService.weather(for:)` throw, and the Dashboard silently falls back to the MET Norway feed with *that* provider's attribution. That is what App Review saw on macOS 1.2.0 (5801) and why it asked, under Guideline 5.2.5, for proof of the ` Weather` mark: the mark is drawn only from a successful WeatherKit response, so it was on no screen anywhere, ours included (measured 2026-09-02 on a Debug build whose embedded profile carried `weatherkit=true`). The App Services toggle is account state, not binary state — flipping it needs no new build, and no profile regeneration — but it is also invisible from the repository, so check it first whenever the pill reads `MET Norway` on a Mac with a location set. `refreshNativeWeather` now logs the thrown error to `swift-daemon.log`.
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

**Current verified delivery, 2026-10-03: 1.6 is public.** Maker Console's approved
1.6 was released after the recorded physical acceptance, and the public listing
reports Version 1.6 (Oct 3, 2026), 758.41 KB. See the
[current listing receipt](marketplace/elgato/LISTING.md#16-published-and-public-2026-10-03).
The older 1.4 review entry was not published. The following records are historical.

`1.0.2` was approved and published on 2026-07-28, `1.0.3` — the Windows compatibility correction — on 2026-07-31, and `1.0.4` on 2026-08-05. `1.0.5` was published on 2026-08-10T18:03:56Z. **`1.0.6` was published on 2026-08-18T16:46Z** and was then the latest public version at [AgentDeck on the Elgato Marketplace](https://marketplace.elgato.com/product/agentdeck-dce3806b-176e-40f2-be7d-e029bec0f464) — the product page's `versions` payload reports `status: published` and `latest_version_number: 1.0.6`. For `1.0.5` the uploaded CI artifact was the `streamdeck-v1.0.5` GitHub Release asset (`SHA-256 5cde49b7f79a2551c04113d1662b59720de3caa7929e2e8072dbcb3e458f6528`), not a locally rebuilt package; the same rule applies to every submission. The Marketplace's **monotonic-version rule applies** — every subsequent submission needs a version above the latest published version, and same-version resubmission (which pre-publication review revisions allowed) is unavailable once that version is published. **`1.2` was approved on 2026-09-02T09:31Z and published at 2026-09-02T21:39:41Z** (2026-09-03 KST) from Maker Console's Versions tab (`Release` on the *Ready to publish* row — one press, no confirmation dialog; the row reads *Published* immediately and the public payload follows). It had been uploaded with auto-publish off so the DRM-processed build could go through the encoder review loop (docs/streamdeck-layout.md) first; that loop was skipped on the owner's instruction, so any encoder regression reported against 1.2 should be checked on the Marketplace-served build before anything else.

The live version is verifiable without signing in to the Maker Console: the product page is a client-rendered SPA, but its Next.js payload carries the version array verbatim, so `curl -s <product-url> | grep -oE '\\"versions\\":\[.{0,1200}'` reports `version_number`, `status`, and `publish_date` for every submission. Check it there before writing a release-status claim into this file — a portal upload that succeeds leaves no trace in the repository, which is exactly how these paragraphs fell a version behind between 2026-07-31 and 2026-08-06.

1. Confirm the main manifest and embedded profile snapshots match the Stream Deck package version as `X.Y.Z.0`.
2. Follow `.agents/workflows/build-plugin.md`, then run `pnpm package` — this validates with Elgato's official CLI (pinned as the `@elgato/cli` devDependency) before packing, so a local failure is a submission the Marketplace would have rejected.
3. Upload to the Elgato Maker portal and tag `streamdeck-v<STREAMDECK_VERSION>` when actually submitted/released.

`streamdeck-release.yml` runs on the tag: it validates, packs, attaches the `.streamDeckPlugin` to a GitHub Release, and uploads it as a build artifact. The Maker-portal upload itself stays manual — Elgato has no submission API.

**2026-09-15 follow-up:** Maker Console approved 1.3 and the authorized Release
action changed its row to Published. Public-page propagation was not immediate;
see [the current listing receipt](marketplace/elgato/LISTING.md). Apple 1.3.2
is independently READY_FOR_SALE on both platforms in
[ASC status run 34909305043](https://github.com/puritysb/AgentDeck/actions/runs/34909305043).

### Ulanzi plugin

**Current verified delivery, 2026-10-03: 1.6.0 is public.** The published-work
record and normal public listing both show 1.6.0, D200/D200H/D200X, without Dial.
No further upload was needed. See the
[current listing receipt](marketplace/ulanzi/LISTING.md#160-public-listing-verification-2026-10-03).
The following records are historical.

`1.0.3` was uploaded on 2026-08-07 and **published on or before 2026-08-24** — the first AgentDeck version ever live on this Marketplace. `1.0.4` was **submitted the same day** as a *Create review version* (D200X keypad, the three agents the published build predates, three new locales, `AI` sub-category, restored seven-language copy, refreshed media); 1.0.3 keeps serving while it is reviewed, verified on the public page after the press. **`1.0.5` replaced that review record in place on 2026-08-25**, so 1.0.4 never reached a user: the Ulanzi Studio team reported macOS Gatekeeper flagging `resvgjs.darwin-arm64.node` on Apple Silicon, and 1.0.5 removes every native binary by moving the rasterizer to `@resvg/resvg-wasm`. Replacing rather than stacking a second review version is the path Ulanzi confirmed on 2026-08-08 ("it's also possible to re-edit and update the file"), and it is the right one here because the reviewer was testing the very build that was wrong. 1.0.5 was in turn replaced in place by **1.2.0 on 2026-09-02**, and **1.2.0 was published within a day**: on 2026-09-03 the public listing reads `Version：1.2.0`. Note the Ulanzi page is client-rendered — `curl` returns no version string at all, so this one is read in a browser (or with the extension's DOM tools), unlike the Elgato payload above.

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
