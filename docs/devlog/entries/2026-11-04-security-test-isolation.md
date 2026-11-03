# 2026-11-04 — Security verification exposed ambient credential fixtures

The security follow-up used a dedicated worktree and temporary data directories,
but those alone did not isolate every credential lookup. In the Node auth suite,
a fresh custom profile inherited the developer's legacy retirement state. The
private-state assertion observed revision 2 instead of 1; the mocked storage-busy
case instead stopped at conflicting-retirement. Diagnosis used failure metadata and source; no manual inspection of the real
credential file or token was needed.

Vitest now gives both named and default `os` imports a temporary home and seeds
its default auth directory with a synthetic token for child fixtures. Explicit
HOME fixtures beneath the OS temporary root remain usable by legacy and
Node/Swift convergence tests. The inheritance fixture supplies revision 3 and
checks that rotation produces revision 4. This keeps production migration
behavior under test with controlled credentials. It is a module/fixture boundary;
subprocesses still need explicit temporary paths and this is not OS sandboxing.

The Apple APME harness had a related fallback: an absent secure-store fixture
could select development-file lookup. Hosted lookups now refuse implicit profiles
and inherited paid-provider environment keys; an inert preferences profile returns
no legacy key. Nine credential cases run in the full macOS Debug and optimized
Preview suites, using storage doubles and temporary profiles.

A separate preliminary integration run overlapped a package build with the
source/dist identity test. Its copied and workspace byte totals diverged. Running
the completed build and verification sequentially passed. Do not mutate dist
while that comparison runs. Adding verification explanations also correctly
failed the Korean-catalog coverage gate until all new copy had translations.

Obsolete PR native runs accumulated while commits and the master baseline moved.
CI, Apple Tests and CodeQL now group runs by workflow and PR number; a newer PR
commit cancels the older run. Master, scheduled and manual runs use unique groups.
Required checks still belong to the current head; cancellation is recorded
separately from success. The first transition also required cancelling older runs
that had no concurrency group.

Local evidence: final quick checks passed 7,568 tests with 42 skips. The unchanged
native source passed macOS Debug (1,525 executed, five skips), optimized Preview
(1,545 executed, 12 skips), Android (577 tests), universal macOS Release and both
iOS configurations. All completed with zero failures. Workflow expression/YAML
validation passed actionlint 1.7.12; unchanged shell steps were outside that lint
invocation. Hosted checks and master reanalysis remain separate in
[PR #721](https://github.com/puritysb/AgentDeck/pull/721) and
[the owner-assigned response record](https://github.com/puritysb/AgentDeck/issues/713).
No signed Keychain, installed-client or physical-device acceptance is implied.

A later complete master scan (`eadab28c`, run 41661877755) introduced alert
#314 in the cron title parser. Its overlapping whitespace and label matches
could retry quadratically on long malformed separators. The response replaces
that expression with one header-boundary lookup and one separator lookup;
synthetic 100,000-tab cases exercise malformed and valid headers. This finding
is outside the historical 266-alert baseline and is recorded separately in
[the additional response](security/reports/2026-11-04-additional-response.json).
Its GitHub fixed state still requires post-merge reanalysis.

The parser follow-up passed 90 focused timeline cases and all 7,570 Vitest
cases (42 skips); changed-area verification passed 189 related cases including
compiled Swift pixel parity. The first restricted run blocked Swift cache and
loopback HTTP access. The permitted rerun passed product checks but selected
system Bash 3 for design lint; rerunning that gate with `/opt/homebrew/bin`
first passed. Changed verification then ran sequentially with that PATH.
These environment failures are not counted as successful runs.

The hosted iOS Release job later passed its app build, then failed while compiling
the Debug test bundle: the shared credential test called macOS-only
`ApmeSettings`. The provider fixture is now compiled only on macOS, while
the eight shared storage/migration cases remain available to iOS. This was a
test-target boundary defect that the earlier product-only iOS build could not
prove absent. The final integration includes master `d835ab9d` and explicitly
runs `xcodebuild build-for-testing` for the iOS Debug test bundle in addition
to the catalogued native matrix. The earlier cancelled hosted Preview job
remains cancelled evidence, not a successful check.

The integrated rerun passed 7,574 Vitest cases (42 skips), Android 581
cases, macOS Debug 1,528 cases (five skips) and optimized Preview 1,545
cases (12 skips), all with zero failures. Universal macOS Release, both
iOS app configurations and the iOS Debug `build-for-testing` succeeded.
The changed-area catalog did not select untouched CloudKit/submission
gates. Required docs/catalog/devlog checks also passed; these checks do not
establish real Keychain or installed-device acceptance.
