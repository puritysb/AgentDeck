# 2026-11-01 — CloudKit device acceptance boundaries

The clean full run for `7db5136e` passed, including both ordinary Apple targets,
Dot Preview targets and the dedicated CloudKit gates. An earlier attempt had
passed the optimized native tests but failed the following artifact step because
we edited the running Bash script while it waited for xcodebuild. Bash resumed
reading at an offset in the changed file. Freeze executable inputs before a long
verification run; successful XCTest output alone did not make that run pass.

The physical iPhone fetched real encrypted counts and original source time, but
its screenshot reported **durable cache write failed**. After process relaunch
there was no restored summary. The Mac disk tests used an injected directory and
could not establish that the production iOS directory was writable. The central
resolver had used a macOS-only sandbox environment flag, which is false on iOS,
and selected the legacy home-root path. iOS now chooses container Application
Support. A storage-only round trip through the actual iOS app passed in the
separate simulator; physical Data Protection and cold-start account restoration
still require an unlocked device. Keep storage failure separate from the
additional case where a missing local iCloud token withholds a saved reader
until online account verification.

An actual fresh OpenCode TUI and loopback model fixture exposed a permission row
with a real request ID but no choices and `liveAnswerable: false`. The iOS
simulator's question selection was independently established by OpenCode's
returned `Phone acceptance` label, rather than inferred from a later permission
wait. The new canonical one-time choices and request-scoped dispatch address the
missing permission path. A Stream Deck response additionally needs the detail
snapshot's request ID; borrowing a newer roster row's ID could turn an old
question press into approval of another tool. Regression tests cover that
transition and superseded requests.

The Stream Deck CLI said its stop request succeeded while the recorded process
remained alive for the complete 120-second wait. Normal host quit/relaunch
recovered the runtime and its installed bundle hash was verified. Virtual Deck
screenshots and synthetic GUI clicks did not establish an SDK key press; do not
attest the physical button path from that evidence. The paired iPhone later
locked, and Xcode explicitly refused runner launch until unlock. This is an
unmet lab prerequisite, not a successful modified-build device test.

Mac automatic publication saved actual summaries, resumed after relaunch, and
retained explicit Stop through another relaunch. A later uncertain cloud outcome
showed the backoff/retained-ID status. These are server/publisher observations;
only the earlier user-confirmed iPhone/Watch presentation establishes visible
notification delivery. See the current contract and acceptance state in
[the remote observation design](docs/apple-remote-observation.md).


The subsequent installed-daemon iOS UI run found a failed ordinary question tap;
the same flow completed when the diagnostic pressed the label area. Both custom
attention button labels now declare a rectangular content shape. The PoC's Close
control also moved into a reserved header. A separate failed rerun had begun
before the native question/channel was ready, so the runner now waits for
enabled/hittable controls and the lab confirms the real pending row first.
The final ordinary-tap test passed in 32.4 seconds, with OpenCode returning both
the exact original selected label and the harmless Bash output. It used no
coordinate fallback. This does not upgrade simulator evidence into physical
phone or Stream Deck hardware acceptance.
