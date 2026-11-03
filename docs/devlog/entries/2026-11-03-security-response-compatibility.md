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
