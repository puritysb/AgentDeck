# 2026-09-15 — npm 1.3.4 Windows fixes and issue triage

External contributions #304, #329 and #330 were reviewed, corrected with
maintainer follow-ups, and merged while preserving their original commits.
#331 and #332 closed through their fixing PRs. The six remaining issues now
carry current scope and exit conditions; #273 no longer describes npm 1.2.0
as awaiting release, and #272 distinguishes completed hardware/refresh research
from outstanding audio and pull-path decisions. #314 preserves old receipts as
history and tracks the current 1.3 series.

PR #333 prepared npm 1.3.4 at `885449a460711acb2c039f04c6341ed5f0bb2eca`.
All four public package versions, the legacy daemon version, and the runtime
surface-welcome fixture agree. Companion versions are unchanged.

## Installed evidence

The four exact-commit tarballs replaced npm 1.3.3 through the real Homebrew
`agentdeck` path. The existing macOS app remained 1.3.2 (local build 4).
Completed direct Codex CLI turns appeared on the Mac and physical Lenovo
under Swift-only and Node-only ownership. Claude was unavailable because of
its organization subscription policy. The updated AgentDeck Codex hooks were
reviewed and activated through the normal hook-trust UI before these checks.

In coexistence the app attached to the sole Node listener on 9120. Stopping
Node caused a transient Swift fallback on 9121; it reclaimed 9120 automatically
after its existing 120-second failed-bind memory expired. A fresh real turn
reached both screens without an app restart or hook reinstall during that
handover. Initial desk normalization and an early Node start needed a supported
restart before the canonical-port measurement. This is not instant failover or
a fix for the separately tracked high-load/serial-ownership issue #327.

Final desk: supervised Node 1.3.4, build `6fcb644a8ed2`, with the app attached.
Twenty settled health probes had zero failures (maximum 90 ms). Native
better-sqlite3 12.11.1 loaded under Node 26.5.0 / ABI 147. Raw evidence remains
private because screenshots and logs include unrelated session content.

## Verification and publication

Build/typecheck, 4,515 tests (two platform skips), protocol generation without
drift, documentation/catalog/token gates and clean-tree lint passed; lint stayed
at baseline 89. Linux, Apple and Windows Node 22/24/26 CI passed. Windows 26's
first Git Bash/PowerShell end-to-end process reached its 10-second test budget;
the unchanged failed-job rerun passed.

The npm publish workflow accepted all four packages, but its first readback
exhausted the bounded registry visibility window for shared. Following the
release runbook, the failed job was rerun without moving the immutable tag.
The retry returned E409: previously staged version 1.3.4. Authenticated
`npm stage list` (both all packages and shared only) returned an empty list.
This matches the upstream registry defect reported in npm/cli#9889, rather than
an actionable pending approval. A fresh 1.3.5 release will supersede the partial
1.3.4 publication; no existing package or tag is overwritten.

The detailed pre-tag receipt is in
[release issue #314](https://github.com/puritysb/AgentDeck/issues/314#issuecomment-5666511504).
