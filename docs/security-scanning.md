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

Any accepted high/critical npm risk needs an exact GHSA/package/version entry in
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
