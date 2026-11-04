# Security scanning

This runbook owns dependency scanning, static analysis, triage and evidence. It
complements [the reporting policy](../SECURITY.md) and [testing](testing.md).

## Automated checks

| Check | Trigger | Failure policy | Evidence |
|---|---|---|---|
| `pnpm security:audit` | PR, master push, daily, manual | Unreviewed high/critical npm advisory, expired exception, registry/schema/execution error | Raw all/production JSON, lockfile and policy hashes, receipt, job summary; 30-day artifact |
| pip-audit 2.10.1 | PR, master push, daily, manual | Any finding or resolution/execution error | Resolved BLE and Robot JSON; 30-day artifact |
| OSV Scanner 2.7.0 | PR, master push, daily, manual | Any non-excepted Rust finding or execution error | Cargo.lock JSON; 30-day artifact |
| Dependency review | PR | Newly introduced high/critical advisory | PR check |
| CodeQL `security-extended` | PR, master push, weekly, manual | Extraction/analysis failures fail the job; alerts need separate triage | GitHub Security → Code scanning |
| Dependabot | Continuous alerts; weekly version PRs | Maintainer review, no automatic merge | Security → Dependabot, update PRs |
| Secret scanning + push protection | GitHub service | Existing provider-secret protections retained | GitHub Security → Secret scanning |

CodeQL currently covers JavaScript/TypeScript, Python, Actions, C/C++ and Rust,
using `build-mode: none`. C++ without target headers/build flags has limited
precision. Separate manual-build jobs extract Kotlin from Android and Swift from
both macOS and iOS Simulator targets; native extraction is verified by its actual
hosted build and analysis result, not workflow presence. A complete
PlatformIO/Arduino dependency inventory and inspection of every installed user
environment still require separate checks.
Dependabot additionally checks Gradle manifests and GitHub Actions. A configured
workflow and a completed analysis are separate states; inspect the actual run.
Snyk has not been run or connected. These checks provide a baseline without an
additional external service account.

## Local execution

```bash
pnpm security:audit
# Optional output directory:
pnpm security:audit diagnostics/security-audit
```

The npm command reads the lockfile and queries the registry without installing
packages or running lifecycle scripts. A registry failure must fail the check.
`diagnostics/` is ignored; retain important dated aggregate evidence in the repo,
and raw workflow receipts in Actions artifacts. Do not commit secrets or private
vulnerability reports.

For Python use a disposable virtual environment, install `pip-audit==2.10.1`, and
run `pip-audit -r bridge/python/requirements-ble.txt` and
`pip-audit -r esp32/robot/requirements.txt`. These resolve the current requirements,
not the packages already installed in a user's BLE environment. On the audited
Mac, Python's `ensurepip` crashed; the successful equivalent used
`uv pip compile --python-version 3.12 --no-build` followed by
`pip-audit --disable-pip --no-deps -r <fully-resolved-file>`. Keep the resolved
package list with the receipt. Linux CI resolves platform-specific packages again.

For Rust use the checksum-pinned OSV binary in the workflow and run:

```bash
osv-scanner scan source --config security/osv-scanner.toml \
  --lockfile shared/glance-raster/Cargo.lock --format json
```

Do not enable Rust call analysis in this scan: it can execute build scripts.

## Triage and exceptions

The maintainer (`puritysb`) reviews failed scheduled jobs and new alerts. Check the
package path, resolved version, advisory prerequisites, affected product channel,
fix availability and compatibility. An alert is a package/advisory match; it does
not establish exploitability in AgentDeck. Prefer the smallest compatible patch,
then rerun the scanner and the applicable verification tier. Source merged,
package published, installed, and device verified are different delivery states.

Any accepted high/critical npm risk needs an exact GHSA/package/version/severity entry in
[the policy](../security/audit-policy.json), an owner, reason, tracking reference,
and expiry. The report keeps the finding visible. Expiry fails even without a
lockfile change. Critical findings require immediate investigation; high findings
need prompt triage and a bounded remediation decision. Moderate/low findings stay
in the receipt and the maintenance backlog. Do not suppress a whole package or
trust `audit --fix` across incompatible major versions. New PR findings also pass
through dependency review; exceptions here do not waive that separate check.

## deepmerge dependency removal — November 4, 2026

The [removal receipt](../security/reports/2026-11-04-deepmerge-removal.json)
records **zero matches across all npm severities**, in both all-dependency and
production audits. `pnpm why -r deepmerge` has no result. This replaces the one
low version match in the November 3 snapshot below.

The only dependency path was the Stream Deck plugin's development-time
`@rollup/plugin-node-resolve@16.0.3`. Its only `deepmerge` call cloned a static
object of arrays and booleans for its frozen `DEFAULTS` export; user options use
object spread separately. A hashed pnpm patch replaces that call with Node's
`structuredClone` in both CJS and ESM entry points. The repository supports Node
22/24/26. An exact-consumer override removes the unused dependency from the
resolved graph, and the former deepmerge mitigation patch is removed.

Regression coverage imports both installed resolver entry points, checks the
frozen default values, and builds/runs synthetic Node-export/CommonJS bundles
with a built-in module. Full workspace builds exercise the actual plugin bundle.
This change preserves Rollup, its resolver options and the official Stream Deck
SDK/CLI; no replacement merge library or broad dependency override is added.

The installed dependencies, lockfile and audit are checked independently.
Dependabot alert [65](https://github.com/puritysb/AgentDeck/security/dependabot/65)
must become `fixed` after default-branch dependency-graph processing; a clean
local audit or PR does not establish its server-side state. No manual dismissal
is needed. These checks do not update an installed plugin or publish a product
release. Firmware inventory, custom secret-pattern coverage and Rust maintenance
items in [713](https://github.com/puritysb/AgentDeck/issues/713) remain separate.

## Historical remediation candidate — November 3, 2026

The follow-up dependency scan reports **production 0**, and **all dependencies
0 critical / 0 high / 0 moderate / 1 low**. These are lockfile audit counts, not
published-product or installed-environment claims. The original snapshot below
is retained for comparison.

- Zod 4.6.6 is scoped to reviewed consumers: Elgato imports `zod/v4-mini`,
  Anthropic/MCP accept v4, and the JSON-schema converter imports the preserved
  `zod/v3` entry point. Recursive option/RPC validation and early rejection of
  oversized bounded arrays are exercised against the installed dependencies.
  The obsolete high-severity Zod exception is removed.
- Quicktype 26, stream-json 3.8.0, glob 14.0.3 and minimatch 11.0.4 remove the
  remaining moderate advisory matches. EJS keeps its CLI/Jake functionality via
  compatible Jake/filelist versions, checked by executing a synthetic template.
  Kotlin generation explicitly retains Klaxon. Generated Swift reference models
  are typechecked separately; application protocol models are not replaced.
- **deepmerge 4.3.1 remains one low version-based finding.** GitHub lists no
  published fixed version. A lockfile-hashed pnpm patch rejects `__proto__` on
  both merge operands, and a regression verifies a normal result prototype and
  ordinary nested/array merges. This is a local mitigation, not an upstream
  version fix or a claim that the scanner reports zero. Recheck upstream by
  **November 17**, owner `puritysb`.
- Rust's three maintenance notices remain a coordinated renderer migration,
  owned by `puritysb`, with exact advisory exceptions expiring **December 1**.
  They are not silently counted as fixed vulnerabilities.

The source candidate also hardens command argument handling, regular-file read
budgets, private atomic writes, HTTP error responses, hook request/concurrency
limits, linear text scanning and configuration-port validation. The per-alert
review distinguishes implemented changes awaiting a master scan from intentional
client flows, test-only code and documented developer outputs. A dismissal is a
review decision and is counted separately from a verified source fix.

Native CodeQL must pin a supported toolchain: **macOS 26 / Xcode 26.6**. Selecting
the newest installed Xcode can select unsupported Xcode 27 / Swift 6.4. See the
[GitHub compatibility notice](https://github.blog/changelog/2026-10-19-codeql-changes-for-macos-27-xcode-27-and-swift-6-4/).
Neither Kotlin's successful PR run nor a still-running Swift build establishes
successful full default-branch coverage.

## Remaining findings

Initial snapshot (historical): **2026-11-03**, source base `48089aea`. npm counts are audit records
(the same GHSA can appear for multiple installed major versions), not a count of
confirmed AgentDeck vulnerabilities.

| Scope | Before: critical / high / moderate / low | After |
|---|---|---|
| npm all (including development) | 1 / 32 / 23 / 5 = 61 | 0 / 1 / 5 / 1 = 7 |
| npm production + optional | 1 / 12 / 6 / 3 = 22 | 0 / 1 / 0 / 0 = 1 |
| Python BLE, resolved on macOS/Python 3.12 | 39 Pillow advisory records on 12.3.0 | 0 on 13.0.0 |
| Python Robot tooling | 0 | 0 |
| Rust lockfile | 3 distinct maintenance advisories, 4 package/version matches | Same; dated maintenance exceptions |

Applied: Express 5.3.0 (body-parser, proxy-addr, qs), Sharp 0.35.5, Vite 8.3.5,
Vitest/coverage 4.1.12, Stream Deck SDK 2.1.2; same-major transitive overrides for
fast-uri, brace-expansion, tar and moment; Pillow `>=13,<14`. The proxy-addr critical
advisory requires particular Express trust-proxy subnet settings; no `trust proxy`
configuration was found in this repository. It was patched regardless.

The Zod exception and development-tool migration deferrals in the first
snapshot have been superseded by the follow-up candidate above. Deepmerge's low
version match and the three Rust maintenance notices remain visible; do not
relabel either as an upstream fixed release.

The initial OSV scan of range-based Python manifests selected Pillow 9.5.0 despite
our `>=12,<13` requirement. It was unsuitable as an installed-version finding.
Resolving the complete requirement set produced 12.3.0 with 39 actual matches;
13.0.0 removed them. This is why Python uses pip-audit resolution rather than raw
manifest inference in the scheduled workflow.

Sources: [pnpm audit](https://pnpm.io/cli/audit),
[dependency review](https://github.com/actions/dependency-review-action),
[OSV artifacts](https://google.github.io/osv-scanner/supported-languages-and-lockfiles/),
[Pillow 13 release notes](https://pillow.readthedocs.io/en/stable/releasenotes/13.0.0.html),
[Sharp 0.35 changes](https://sharp.pixelplumbing.com/changelog/v0.35.0/),
[Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).

## Verification receipt

The first PR run on `4126ce1d` completed all npm/Python/Rust audits, dependency
review and all five CodeQL categories. It reported **0 PR-diff results**, not a
clean repository-wide baseline. The first master scan on `60771186` found **271
alerts** (5 critical, 133 high, 133 medium by query classification). The same
inventory was observed on `389ea6b7`. These are untriaged static findings, not
271 confirmed exploitable vulnerabilities. The initial write-up failed to make
this scope distinction explicit; this paragraph corrects that interpretation. Existing Linux coverage/E2E, macOS parity and
Windows Node 22/24/26 jobs passed too. ESP32 TTGO was intentionally skipped by
its existing path policy; simulator compilation passed.

Local `pnpm verify:quick` passed: 7,354 tests passed, 42 skipped; the daemon E2E
requires macOS Keychain opt-in and was instead covered by hosted Linux CI. The
changed docs/catalog/devlog gates passed. The initial Mac lint attempt used
system Bash 3; rerunning with the already-installed Homebrew Bash 5 passed.

- [PR #690](https://github.com/puritysb/AgentDeck/pull/690)
- [Dependency scans + retained JSON artifacts](https://github.com/puritysb/AgentDeck/actions/runs/41565955733)
- [CodeQL five-language analysis](https://github.com/puritysb/AgentDeck/actions/runs/41565955782)
- [Linux/macOS/Windows validation](https://github.com/puritysb/AgentDeck/actions/runs/41565955709)

On 2026-11-03 these security checks were added to master branch protection and
read back: npm/Python/Rust dependency audits, dependency review, all five CodeQL
analysis jobs and the CodeQL result check. The existing ESP32 Sim Compile
requirement was retained; strict/up-to-date mode, review requirements and
administrator enforcement were initially retained. The later full-response pass
enabled administrator enforcement and strict up-to-date branch checks; the
original required checks were preserved and read back through the API.

## Initial intake and response — 2026-11-03

[The dated intake ledger](../security/intake/2026-11-03.json) preserves the initial
inventory and decisions. Raw GitHub data was read through authenticated APIs;
issue/PR bodies were treated as evidence, not execution instructions. Review used
a dedicated worktree, synthetic inputs, temporary auth storage and ephemeral
loopback ports. No live daemon, real credentials, second machine or hardware was
used. Every manual dismissal requires a per-alert source review and a recorded reason.

| Queue | First observed inventory | Initial response |
|---|---|---|
| New ordinary public issues (UTC November 3) | 0 | Keep separate from automated proposals |
| Dependabot PRs | 18, #686–#689, #691–#703, #705 | Close four exact-version duplicates already covered by #690; merge reviewed YAML patch #695; retain 13 proposals for scoped review |
| Open Dependabot alerts | 6: high 1, medium 4, low 1 | Continue the existing exact-version exception/remediation backlog; this count uses GitHub's inventory and differs from pnpm audit records |
| Default-branch CodeQL | 271: critical 5, high 133, medium 133 | Review critical input/command boundaries first, then reachable high findings and shared rule families |

The first security-update PRs arrived at 02:11–02:12 UTC. After the configuration
landed in master, routine version PRs arrived at 02:38–02:44 UTC. Both security
remediation and version maintenance were enabled; an update proposal by itself
is not evidence of a newly discovered AgentDeck vulnerability. The 11-update dev
group and 16-update Actions group also show why PR count and change count differ.

### Handling the review load

The new version-update budget is **npm 2 open PRs; Actions, Cargo, pip and Gradle
1 per configuration entry**. The pip entry spans two directories; this is not a
repository-global cap. Weekly checks remain enabled. Development and Actions
version groups cover compatible minor/patch updates; major migrations get
separate review. Existing open proposals are not blindly merged or silently
counted as resolved. This limit affects routine version PRs; GitHub security PRs
have a separate fixed limit of 10. Alerts and security updates remain enabled.

Work in batches with one accountable owner (`puritysb`):

1. Triage critical-class findings first: verify input types, authentication,
   caller control and platform-specific command semantics. The first patch adds
   explicit runtime checks for tokens and binary voice payloads; it is hardening,
   not proof that all critical-class findings were remotely exploitable.
2. Review reachable high findings next, especially file and command boundaries.
   Group repeated findings by shared helper and actual trust boundary; validate a
   fix once at that boundary, then re-scan the default branch. The remaining
   critical-class command finding has a reviewed Windows argument-list patch in
   PR #710; verify its closure against the full master analysis.
3. Review developer/test-only findings with their actual isolation and exposure.
   A test fixture is evidence to inspect, not a blanket reason to dismiss a rule.
   The full baseline has received per-alert source review; native re-analysis and
   source delivery remain separate. Revisit maintenance/migration decisions by
   **November 17**.
4. For every decision record the affected IDs/family, owner, prerequisites,
   disposition (untriaged, investigating, patch proposed, verified fixed,
   superseded, or a reasoned exception), source commit and verification scope.
   Mark a CodeQL finding fixed only after the master scan confirms it; a green PR
   analysis or a source patch alone is insufficient.

On each review, append a dated snapshot/delta rather than rewriting the original
baseline. Compare default branch + category + query suite consistently. A lower
count caused by scan exclusions, a query-suite change or dismissal is not a
remediation count. Keep unpatched exploit details in private reporting channels;
public notes can publish aggregates and validated delivery status.

Sources: [PR alert scope](https://docs.github.com/en/code-security/concepts/code-scanning/code-scanning-alerts),
[separate Dependabot PR limits](https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-errors).

## Workflow execution integrity

Remote Actions are pinned to full commit SHAs. Their version comments retain
Dependabot update support; the pinned Rust Action embeds toolchain 1.90.0 in its implementation.
Only its supported target inputs are supplied. Workflows declare token permissions explicitly.
Release jobs retain their existing publication scopes; ordinary test workflows
receive read-only repository contents. Native CodeQL builds disable compilation
caches so a cache hit cannot masquerade as source extraction.

## Scan freshness and scheduled execution

`security-health.yml` checks the default branch on every PR/push, hourly and on
manual dispatch. Dependency scans have a 26-hour deadline and CodeQL has an
eight-day deadline. A recent push/manual success does not prove cron ran: the
last scheduled execution is recorded separately. During the initial bounded
startup window, missing schedule history is `unverified` with a warning. It
fails after that deadline. Disabled workflows, failed/latest overdue scans,
stuck execution and unavailable GitHub evidence fail the checker. Receipts and
summaries are retained for 30 days. The watchdog cannot guarantee delivery by
GitHub's scheduler; PR/push/manual runs supply additional detection points.

Initial promotion: Kotlin CodeQL run 41628618438 and freshness run 41628618531 succeeded.
Their exact check contexts were added to master protection with the existing
eleven checks preserved (13 total), strict up-to-date checks and administrator
enforcement retained. Readback verified that intermediate list. Swift was
left unrequired pending hosted validation; the completed follow-up is below.

## Per-alert response ledger (November 3 follow-up)

The [266-alert review ledger](../security/reports/2026-11-03-alert-review.json)
records each source location, decision, reasoning and independently read GitHub
state. Source fixes are in [#712](https://github.com/puritysb/AgentDeck/pull/712);
a candidate fix is kept separate from default-branch scan closure. Earlier
271-alert and dependency receipts remain historical snapshots. New PR-only
fingerprints are listed separately.

Manual closure proposals remain open pending explicit approval after automatic
approval review rejected bulk dismissal as a persistent reduction in security
visibility. Do not interpret the review classification as a completed GitHub
state change or count a dismissed finding as a vulnerability fixed by code.

The [firmware inventory](../security/reports/2026-11-03-firmware-inventory.json)
covers 16 declared build environments and read-only local library caches. It
does not establish complete framework/SDK resolution or advisory coverage.
[Owner-assigned #713](https://github.com/puritysb/AgentDeck/issues/713) tracks
that gap and deferred major migrations for November 17 review; existing Rust
maintenance exceptions expire December 1. No Snyk integration is claimed.

At the initial ledger snapshot, the candidate npm audit had zero production matches and one
low development-only deepmerge version match with a tested local mitigation.
The compatible OkHttp 4.12.1 backport was then being validated separately from
the 5.x proposal. Kotlin analysis had passed, while Swift extraction and the
first scheduled event were unverified. The completed follow-up is below.
The freshness watchdog's hosted check passed; manual and push runs do not prove
a cron event occurred. Product release and physical device acceptance remain
separate delivery work.

### Resolved Android runtime follow-up

The [dated Android receipt](../security/reports/2026-11-03-android-runtime.json)
resolves both runtime classpaths offline, explicitly rejects unresolved graph
edges and excludes project components. The 136 unique external Maven
coordinates had no OSV matches. A known-vulnerable Guava version produced three
advisories as a control, while the earlier OkHttp 4.12.0 still produced none at
that checkpoint. Upstream release-note review independently identified the
certificate backport; the database result does not remove that requirement.
AAR-internal native code and OS/device versions remain outside this scope.
CI automation of the dated collection remains assigned in #713.

The [readable manual-closure list](../security/reports/2026-11-03-review-closures.md)
contains the exact alert IDs and source reasons from the review ledger. It is
a proposal awaiting approval, not a completed dismissal record. Reconcile
GitHub state again after master analysis before acting on that list.

Final source-head verification at `1083235e`: quick checks passed with 7,561
tests and 42 skips. Local macOS Debug passed 1,516 cases with five skips; the
optimized preview suite passed 1,536 cases with 12 skips, both with zero
failures. macOS universal Release and both iOS configurations built. The
preliminary universal build failure was a missing Intel Rust standard library;
a checksum-verified temporary 1.90.0 toolchain supplied the missing target.
The original sandbox/target failures remain distinct from the permitted passes.

Both Swift target analyses in run 41634861851 completed successfully on head
`1083235e`; the iOS analysis uploaded at 12:54 UTC. Kotlin and all five existing
language jobs also passed. All eight exact analysis checks are now required,
with the previous thirteen checks preserved (15 total). Readback verified the
list and strict up-to-date policy. The default-branch inventory must still be
read after merge; a PR result does not substitute for that inventory.

### Master reconciliation after #712

The [post-merge checkpoint](../security/reports/2026-11-03-master-response.json)
records 77 of the 266 baseline fingerprints marked fixed, three individually
dismissed and 186 still open on `05a9bef6`. Six of the original 185 manual
proposals were automatically marked fixed after source changes, so they are
removed from the current proposal list. Two reviewed intentional/custom-limiter
paths and the new SSE fingerprint #302 are included; the current manual proposal
contained 182 open IDs at that checkpoint. No bulk dismissal was performed.

Five remaining OTLP dynamic-write findings receive a Map container follow-up.
The earlier null-prototype object and reserved-name checks mitigate pollution,
but Maps make arbitrary keys data throughout resource/span merging and lookup.
Actual parser tests preserve malicious-name handling and span/resource
precedence. Quick checks passed with 7,562 tests and 42 skips. Default-branch
scanner closure of those five candidates remains to be read after merge.
Native master analysis is tracked separately from the completed eight-category
PR analysis; the checkpoint retains each job's actual state.

### First full native inventory

The first full master Android/iOS analyses on `05a9bef6` produced nine additional
fingerprints, despite zero PR-diff results. The [native response ledger](../security/reports/2026-11-03-native-response.json)
records each finding separately. #721 disables credential-bearing Android backup
and device transfer, projects connection logs to host/port, pins two wake commands
to `/system/bin/input`, and removes Apple judge-key persistence in UserDefaults.
Shipped Apple apps use device-local Keychain storage with acknowledged migration
and no plaintext fallback; unsandboxed developer profiles retain the private Node
CLI JSON contract. See [the APME credential contract](apme.md#remote-judge-api-key-storage).

Four native findings receive an individual policy review: the verified,
user-confirmed APK updater and three certificate-pinning queries. Their ledger
records existing signer/hash/version checks, standard TLS verification,
self-hosted endpoints and plain-LAN confidentiality limits. They remain open;
the manual proposal grew to 186 IDs including these four. No review decision is
counted as a source fix. Actual native reanalysis and installed/OEM acceptance
remain separate evidence.

The completed macOS full analysis then added #312/#313, both evaluating a fixed, generated
Pixoo bundle script. Production never accepts a peer-provided
script; bounded JSON is passed as function arguments without source interpolation.
The injected-source seam belongs to a standalone test fixture. These two reviewed
findings remain open too, bringing the proposal at that checkpoint to **188 IDs**.
All eight full master categories completed successfully in run 41642410793;
completion and zero findings are different assertions.

Actual scheduled events were subsequently observed: dependency scan
[41625000788](https://github.com/puritysb/AgentDeck/actions/runs/41625000788) and
five-language CodeQL
[41626812174](https://github.com/puritysb/AgentDeck/actions/runs/41626812174)
completed successfully on earlier head `a37e87ab`. These prove the existing cron
triggers ran, not latest-source acceptance or native-category cron coverage.
The hourly health workflow's first scheduled event remains unobserved; its
push/PR checks and deterministic freshness-policy regressions are separate.

The final APME harness review also separates hosted tests from development-file
fallbacks. An inert preferences profile does not read a legacy key; hosted
provider lookups ignore inherited paid API keys and require an explicit temporary
profile directory. Regression fixtures exercise both refusal and the permitted
temporary-profile path without reading a real credential. This narrows the
isolation claim to the APME paths covered by the tests.

### Superseded PR runs

CI, Apple Tests and CodeQL share a workflow-specific PR-number concurrency
policy: a newer commit cancels an older run for that PR. Required checks still
apply to the latest commit. Master pushes, scheduled events and manual runs use
unique run groups so a PR update cannot cancel those audits. Cancelled results
are preserved as cancelled, never counted as a successful scan. This addresses
the observed queue of obsolete native builds during remediation.

The Node test setup now directs module home lookups to a temporary home and
seeds its default auth directory with a synthetic token. Temporary explicit
HOME fixtures remain supported for legacy migration scenarios. This prevents
an empty test data directory from importing a real legacy credential state;
the fixture also verifies authoritative retirement inheritance. This is a
module/fixture boundary, not a disposable OS sandbox for every subprocess.

The dated proposal files preserve their observed master commit. Before approving
manual closures, compare the exact still-open set with the latest master results
in [#713](https://github.com/puritysb/AgentDeck/issues/713). Automatically fixed
fingerprints leave that approval set; historical fixed/dismissed/open counts keep
their original analysis scope and capture time.
