# 2026-11-11 — Bound TUI fixture type-checking work

### Incident

The serialized macOS parity job in [CI run 42947732036](https://github.com/puritysb/AgentDeck/actions/runs/42947732036)
failed when `xcrun swiftc` reached its 30-second deadline in
`tui-terrarium-snapshots.test.ts`. The other 22 test files passed. The same TUI
source passed in 8.31 seconds in [run 42949041427](https://github.com/puritysb/AgentDeck/actions/runs/42949041427).
Both used the Intel macOS runner and Xcode 26.6; file serialization was already
enabled, so reducing Vitest concurrency again would not address this failure.

### Measurement and decision

The generated Swift table put all twelve frames in one dictionary initializer.
On an arm64 Mac with Apple Swift 6.4.2, `-debug-time-expression-type-checking`
attributed 955.79 ms to that expression. Splitting it into explicitly typed,
private per-frame constants reduced the longest expression to 36.55 ms. Full
fixture compilation with the same diagnostics fell from 1.88 to 0.69 seconds.
These are local observations, not Intel CI timings or proof that every source
of runner variability is eliminated.

The generator now emits those frame constants and a reference-only dictionary.
The original 30-second compiler deadline, 10-second replay deadline and
60-second test deadline remain unchanged. Extending the deadline or retrying
the compiler would hide the expensive expression rather than reduce its work.

### Evidence boundary

The baseline and split native executables produced identical parsed JSON for
all 24 color/frame combinations and seven scale boundaries. The existing
generated-source drift gate and Swift/Node pixel comparisons remain; a new
structural regression prevents combining all frames into one initializer again.
The focused macOS suite passed all 21 tests. Hosted Intel CI must still validate
the fix after publication; this entry does not claim that unrun result.
