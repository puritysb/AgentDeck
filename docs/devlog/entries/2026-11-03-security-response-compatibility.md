# 2026-11-03 — Security response compatibility and verification boundaries

The dependency follow-up reduced the lockfile audit from seven records to one
low development-only record; production has none. This is an installed-version
match result for the candidate lockfile, not proof of a delivered product update.
The original receipt in `security/reports/2026-11-03.json` remains historical.

Elgato's declared Zod range was misleading for migration planning: the installed
utilities import `zod/v4-mini`, while the schema converter imports `zod/v3`.
Zod 4.6.6 retains both entry points and the Anthropic/MCP peers accept v4.
Scoped overrides passed actual recursive option/RPC consumers and a bounded-array
early-rejection regression. A broad untested Zod-major override was rejected.
Quicktype's new Kotlin default required an explicit Klaxon flag. Direct Swift
typechecking also found a pre-existing impossible Equatable synthesis on
BridgeEvent's JSONAny dictionary; reference generation now keeps Codable there.
These reference models do not replace the native application's handwritten wire
models. The existing schema drift gate and a new hosted Swift compile step cover
different failure modes.

Deepmerge has no published fixed version at this checkpoint. A pnpm patch blocks
the result-prototype setter from either merge operand; the package version and
its low audit finding remain visible. Fabricating a fixed version or removing
the warning was rejected. The EJS CLI still depends on Jake, so its upgrade was
checked with an actual synthetic template rather than deleting the dependency.

Candidate verification: quick checks passed with 7,396 tests and 42 platform
skips; ESP32 host tests and simulator surface checks passed; iOS Release built.
The macOS run executed 1,514 XCTest cases with five skips and one failure in the
unchanged GlanceFrameTests route-signature comparison. Its implementation and
test were identical to the branch base; the earlier run passed. Keep this failed
receipt distinct from a pass, integrate the newer native fixes, and rerun before
claiming the integrated candidate's native verification.

CodeQL native workflow selection also needs explicit compatibility: GitHub's
October 19 notice excludes Xcode 27/Swift 6.4 traced analysis. Selecting the newest
installed Xcode is unsafe for that job even when the application itself builds.
PR #710 pins Xcode 26.6 and checks the compiler version. Kotlin extraction passed;
Swift extraction must be assessed from the completed hosted analysis, not its
workflow definition or an ordinary app build. Obsolete runs are cancelled only
after their replacement head is pushed. Manual/push scans are never substituted
for evidence that the scheduled event fired.

Review and tests use dedicated worktrees, synthetic subprocess arguments,
temporary profiles and ephemeral loopback sockets. No live daemon, credential,
Keychain item or connected board was used. Private advisory details remain in the
private reporting channel. Runbook: [docs/security-scanning.md](docs/security-scanning.md).

After integrating the source and verification work from #709/#711, quick checks
passed with 7,561 tests and 42 platform skips. The complete macOS Debug/XCTest
suite and iOS Release build passed in the same isolated DerivedData profile; the
previously failing Glance route case passed too. The failed earlier receipt is
retained separately. Incoming-only source paths were byte-compared against the
integration branch; only local XcodeGen path churn was excluded from the commit.

Hosted Debug run 41628618471 failed with NSGenericException, “Task created in
a session that has been invalidated”. The exported xcresult shows another
connect/disconnect racing URLSession task creation during the long socket test.
Disconnect now preserves its synchronous generation boundary on the same serial
transport queue as task creation; a concurrent connect/stop regression exercises
that boundary. The lifetime test remains longer than the old 120-second deadline.
The pinned Rust Action embeds 1.90.0 and accepts only target/components inputs;
the unsupported toolchain input was removed after the hosted warning.

The follow-up quick check passed (7,561 tests, 42 skips). The full local macOS
Debug suite passed 1,516 cases with five skips and no failures, including the
concurrent stop regression and unchanged 125-second socket lifetime test.
Sandbox-restricted preliminary attempts failed to execute Swift macro plugins
and local socket tests; those are retained separately from the permitted run.

Hosted Swift extraction remained in compilation for more than 30 minutes. The
follow-up uses whole-module compilation with optimization disabled to avoid
repeating module-wide work across primary-file frontend jobs, while retaining
all product sources, supported Xcode and security-extended queries. Its actual
hosted result is still required; an ordinary build is not extraction evidence.
Local universal Release initially lacked the Intel Rust standard library. An
isolated, checksum-verified Rust 1.90.0 toolchain supplies both macOS targets;
no user's compiler defaults were changed.

Android dependency review found a security backport hidden by the proposed
OkHttp major update (#700). Upstream's October 20 advisory describes certificate
blocklisting for compromised intermediate certificates (CVE-2026-111943);
4.12.1 supplies the same protection without the 5.x API migration. This matters
for AOSP/e-ink devices without current Google Play certificate updates. The app
uses OkHttp's standard hostname verifier. Android dependencyInsight resolved
4.12.1; 576 JUnit tests in 61 suites passed, and quick checks passed with 7,561
tests and 42 platform skips. No installed app or device was updated.
Source: [upstream advisory](https://publicobject.com/2026/10/20/mitigating-bad-roots-in-okhttp/).

PR #712 passed all 29 checks, including actual Kotlin and both Swift target
extractions. Its PR view had no open alerts. The full default-branch scan on
05a9bef6 then marked 77 of the 266 baseline fingerprints fixed and retained
three earlier individual dismissals; 186 baseline alerts remained open.
This is another reason to preserve the branch/range distinction.

Six originally proposed manual closures became fixed automatically. Five OTLP
dynamic writes remained flagged despite the null-prototype/reserved-key
mitigation; the follow-up uses Map throughout attribute storage/merging. Two
remaining intentional/custom-admission paths and new SSE fingerprint #302
belong in manual review. The reconciled proposal contains 182 open IDs, not
the initial 185. No bulk or split dismissal was performed after automatic
approval review rejected the operation. Fingerprint counts are not counts of
independent product vulnerabilities.

The [dated checkpoint](security/reports/2026-11-03-master-response.json) retains
source locations, actual states, review reasoning and pending master jobs.
The [readable list](security/reports/2026-11-03-review-closures.md) mirrors the
current proposal; the earlier 266-row receipt remains historical.

Dependabot recreated the exact MCP SDK development pin as #718 after the
initial compatible group was consolidated. The installed 1.32.2 follow-up
retains a zero-production/one-low-development npm audit. Its first quick run
failed three unchanged session-registry cases with EADDRINUSE on test ports
29320/29323/29325; no process was stopped to clear them. The ports were free
before a full rerun passed 7,562 tests with 42 skips. Preserve the port-collision
receipt separately; isolated worktrees do not isolate hard-coded loopback ports.
