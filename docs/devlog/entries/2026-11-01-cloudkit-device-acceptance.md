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


Final review also found that `checkAccount` collapsed every non-available status
into confirmed account absence. That could erase a valid local reader when
CloudKit could not determine state. The native regression now drives the actual
reader model and disk file through unknown/temporary/restricted states, then
confirmed logout. Unknown retains the file without exposing an unverified
reader; logout clears it. Account-change notification consent revocation remains
intact. The final full receipt must describe this fix as well; the preceding
`979742d5` full run was intentionally interrupted before its record was written.

The clean integrated `9c59666b` run completed all 26 automatic gates in 52m11s;
the two policy/platform skips and three unattested lab gates remain explicit in
its receipt. A final ordinary-tap simulator run also passed (Xcode elapsed
28.156s), with the original question label and actual harmless Bash output.
Its bounded fixture was stopped and its real daemon row disappeared. The signed
Mac/iPhone PoC candidates were installed; the phone still required its passcode.

Long-running Mac observation exposed a recovery problem after an account-change
notification. That notification alone is not evidence of an actual user account
switch. Revoking consent was correct, but deleting the installation ID made
same-account enablement conflict with the existing summary's writer ownership.
The follow-up keeps only the disabled account-scoped writer binding and revisions;
pending episodes/session mappings still clear and explicit enablement still
verifies identity. A real-disk regression covers the harder pre-restoration case:
saved consent must become false even when no in-memory publisher was loaded.
Another account cannot adopt that binding under the existing identity guard.

The first follow-up quick run exposed a lab-fixture startup race: it printed
ready metadata before registering SIGTERM/SIGINT handling. An immediate parent
signal could therefore terminate by signal instead of completing child cleanup.
Handlers and the child-exit listener now register before publishing readiness.
The existing parent-signal/deadline tests cover that ordering. An unchanged WS
auth test also exceeded its 60ms rejection grace under concurrent native build
load; both isolated suites then passed (five tests). No auth behavior was relaxed.
