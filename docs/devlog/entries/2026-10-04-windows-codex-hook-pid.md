# 2026-10-04 — Windows Codex hook launcher identity

## Issue audit

[#429](https://github.com/puritysb/AgentDeck/issues/429) still listed the Codex PID
header as missing. POSIX lifecycle commands already send it through `exec sh -c`
and ship in 1.7.0; Windows was the remaining transport gap. Existing Swift/Node
headless-child folding and run-close implementation is unchanged.

## Change

[hooks/src/codex-install.ts](hooks/src/codex-install.ts) now builds the Windows
lifecycle and notify scripts with one bounded native process snapshot. It follows
only command-runner shells to `codex.exe`, sending `X-AgentDeck-Pid` for that
process. Missing, cyclic or unrelated ancestry omits the header and still sends
the unchanged UTF-8 body. No shell PID is substituted for unknown identity.
The CIM operation is limited to one second. The registry health probe now matches
the POSIX 300ms budget, leaving room for the existing one-second POST inside
Codex's three-second Interrupt ceiling. The installer refreshes the managed block
and notify sidecar idempotently, preserving user settings and hook trust records;
changed commands still require Codex's ordinary trust.

The Windows CI matrix now includes Codex installer tests and
[windows-codex-pid.test.ts](hooks/src/__tests__/windows-codex-pid.test.ts).
It executes generated PowerShell with a real process whose executable is named
`codex.exe` (a copied Node runtime, not a model session), through `cmd.exe`;
negative cases cover an unrelated launcher, unavailable CIM and cyclic evidence.
This tests native ancestry/transport, not a live Codex model turn or Windows
hardware. The verification catalogue and Windows reference describe that scope.
The observation rule also corrects its stale legacy-Kiro wording to reflect #451.

## Local verification

- Build/typecheck passed; full Vitest 5,124 passed, six skipped (four Windows-only
  cases plus two existing skips on macOS).
- Protocol generation has no drift; token mirrors, docs and design catalogue pass.
- Raw design lint retains 92 existing violations, with no UI/style changes.
- Windows native execution is delegated to the existing Node 22/24/26 CI matrix;
  its result must be checked before merging or closing #429.
- No installed hooks, daemon environment or queued release builds are modified.
