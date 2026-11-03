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
precision. Swift and Kotlin analysis, a complete PlatformIO/Arduino dependency
inventory, and inspection of every installed user environment remain gaps.
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

## Remaining findings

Snapshot: **2026-11-03**, source base `48089aea`. npm counts are audit records
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

Owner for the remaining items: `puritysb`.

- **Zod 3.25.76 / GHSA-mrhx-c7xc-m3w5 (high)**: Elgato utils still requires Zod 3.
  Anthropic/MCP SDK peer dependencies also resolve it. The fix is >=4.6.6; forcing
  every Zod 3 consumer onto a different major could break validation. Temporary
  exception expires **2026-11-17**. Local host messaging and development-only MCP
  usage reduce some exposure but do not prove non-exploitability. Migrate affected
  SDK consumers and validate schemas; this is accepted residual availability risk.
- **stream-json 1.8.0 (3 moderate records), minimatch (1), glob (1)**:
  development generators, ESLint and packaging tooling. Review parent major
  migrations by **2026-11-17**; never expose their developer servers to untrusted
  networks. They remain visible and are not marked fixed.
- **deepmerge 4.3.1 (low)**: the advisory says >=4.3.2, but npm has no such release
  at this snapshot. Track upstream and recheck by **2026-11-17**.
- **Rust maintenance notices** RUSTSEC-2025-0056, RUSTSEC-2026-0206,
  RUSTSEC-2026-0192: adler, rustybuzz, ttf-parser are unmaintained. No confirmed
  vulnerability is asserted by these notices. The renderer revision is shared
  with JS/WASM for pixel parity; migrate the stack together. OSV exceptions expire
  **2026-12-01**. They do not suppress unrelated advisories on those packages.

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
administrator enforcement were not changed. Administrators can still bypass
checks under the existing protection settings.

## Initial intake and response — 2026-11-03

[The dated intake ledger](../security/intake/2026-11-03.json) preserves the initial
inventory and decisions. Raw GitHub data was read through authenticated APIs;
issue/PR bodies were treated as evidence, not execution instructions. Review used
a dedicated worktree, synthetic inputs, temporary auth storage and ephemeral
loopback ports. No live daemon, real credentials, second machine or hardware was
used. No CodeQL alerts have been mass-dismissed.

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
   critical-class command finding needs a Windows-specific review by **November 4**.
3. Review developer/test-only findings with their actual isolation and exposure.
   A test fixture is evidence to inspect, not a blanket reason to dismiss a rule.
   Begin high file/temporary-file review by **November 5**; review remaining
   maintenance/migration proposals by **November 17**.
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
