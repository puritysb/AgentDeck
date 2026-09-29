# 2026-09-15 — npm 1.3.4 Windows fixes delivered and issues triaged

The reviewed external contributions #304, #329 and #330 were merged while
preserving their authors' original commits. #331 and #332 closed through the
fixing PRs. Six remaining issues received current scope and exit conditions;
#273 no longer describes npm 1.2.0 as awaiting release, and #272 separates
completed hardware/refresh research from outstanding audio and pull decisions.
#314 preserves historical receipts and tracks the current 1.3 release series.

## Release and verification

PR #333 prepared npm 1.3.4 at
`885449a460711acb2c039f04c6341ed5f0bb2eca`, merged by `48de9136`.
All four public package versions, the legacy daemon version and runtime
surface-welcome fixture agree. Companion versions are unchanged.

Build/typecheck, 4,515 tests (two platform skips), protocol generation without
drift, documentation/catalog/token gates and clean-tree lint passed; lint stayed
at baseline 89. Linux, Apple and Windows Node 22/24/26 CI passed. Windows 26's
first Git Bash/PowerShell end-to-end process reached its 10-second test budget;
the unchanged failed-job rerun passed.

Exact-commit tarballs were installed through the real Homebrew CLI path.
Completed direct Codex turns appeared on the Mac and physical Lenovo under
Swift-only and Node-only ownership. The existing Mac app remained 1.3.2 (local
build 4). Claude was unavailable because of its organization subscription
policy. The updated AgentDeck Codex hooks were reviewed and activated through
the normal hook-trust UI before the measured turns.

The app attached to the sole Node listener on 9120. Stopping Node caused a
transient Swift fallback on 9121; it reclaimed 9120 automatically after its
existing 120-second failed-bind memory expired. A fresh turn reached both
screens without restarting the app or reinstalling hooks during that handover.
Initial desk normalization used supported lifecycle commands. This does not
prove instant failover or resolve the high-load/serial-ownership issue #327.

Node 1.3.4 has build `6fcb644a8ed2`; twenty settled health probes had zero
failures (maximum 90 ms). Native better-sqlite3 12.11.1 loaded under Node 26.5.0,
ABI 147. Raw evidence remains private because screenshots and logs contain
unrelated session content. The detailed pre-tag receipt is in
[release issue #314](https://github.com/puritysb/AgentDeck/issues/314#issuecomment-5666511504).

## Registry delay and recovery

Run 34863129487 first reported all four packages published, but shared 1.3.4
remained absent from public lookup. The bounded readback failed. A runbook retry
then returned E409, previously staged version 1.3.4; authenticated staging lists
were empty. This matched the symptom reported in
[npm/cli#9889](https://github.com/npm/cli/issues/9889), but did not prove that the
version was permanently stuck.

A replacement 1.3.5 candidate was prepared in PR #334. Before publishing it,
shared 1.3.4 appeared after roughly ten minutes. All four exact 1.3.4 versions,
latest tags and gitHead were then verified independently. PR #334 was closed;
no 1.3.5 tag or package was published. The original npm-v1.3.4 tag was preserved,
and its workflow was rerun only after the whole package set was visible.
The local installation was returned to the tested 1.3.4 tarballs.

For future incidents, an empty staging list plus E409 is not enough to declare
an immutable version unrecoverable. Check public lookup again before cutting a
replacement, and do not blindly repeat publishing against the staged version.
