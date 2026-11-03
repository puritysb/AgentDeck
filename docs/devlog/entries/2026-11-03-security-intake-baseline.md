# 2026-11-03 — Security setup exposed separate review queues

Enabling alerts/security updates before the first baseline patch produced four
Dependabot PRs (#686–#689), then committing the version-update configuration
produced fourteen more (#691–#703, #705). API inspection found no new ordinary
public issues in that UTC-day window. Treating all eighteen proposals as eighteen
new product vulnerabilities would mix security fixes, routine upgrades and major
migrations. The exact versions in the first four were already present after
#690; they were closed as superseded. YAML patch #695 passed hosted checks and
was merged separately. Every remaining proposal has an owner/disposition in the
[initial intake](security/intake/2026-11-03.json).

The more consequential measurement error was interpreting the first PR CodeQL
result as a repository baseline. PR `4126ce1d` reported zero results for its diff.
Master `60771186` subsequently produced 271 alerts: JS/TS 234, Actions 30,
Python 3, C/C++ 4, Rust 0. Master `389ea6b7` repeated that inventory. Query security
classification was critical 5 / high 133 / medium 133; these are findings to
triage, not 271 demonstrated attacks. The earlier report now explicitly records
the PR scope and links the default-branch correction rather than erasing zero
from its original context.

Start response at trust boundaries, then group repeated findings by shared
helper. The first hardening batch checks token values at runtime and requires
binary audio rather than trusting TypeScript casts or a JSON `length` field.
Tests used temporary auth storage and ephemeral loopback HTTP, with a fake
transcription backend. No installed daemon, real credentials or hardware was
used. Do not mark alerts fixed until the default-branch re-scan confirms them;
reviewer decisions and source tests are different evidence.

The PR budget now limits routine version proposals per ecosystem configuration;
it does not disable alerts or consume GitHub's separate security-update PR
budget. The Actions group is limited to minor/patch changes so one proposal does
not silently combine multiple runner/action major migrations. Existing backlog
still needs review; a lower PR limit does not resolve it.

[The runbook](docs/security-scanning.md#initial-intake-and-response--2026-11-03)
owns the response cadence and evidence states. Raw alert paths/messages stay in
GitHub Security and ignored local evidence; the public ledger retains aggregates,
source references and decisions without publishing unpatched exploit details.
