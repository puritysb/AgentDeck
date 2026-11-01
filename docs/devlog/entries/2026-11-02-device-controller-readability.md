# 2026-11-02 — Bound device controls and readable decisions

Generic Review/Commit/Go on/Clear and suggested-task buttons no longer match the
primary controller role. Keep their backend compatibility routes and independent
evaluation workflow, but reserve primary controls for actual requests, supported
interrupts, native settings and explicit user input. Small cards can be useful
observation/focus surfaces without pretending to be complete approval dialogs.

The compact serial roster omitted native permission IDs and delivery evidence.
Adding these fields exposed an existing 3,500-byte frame-budget assumption under
crowded requests. Reduce the selected cohort and report its total instead of
raising the budget or stripping approval identity. A compact subject beyond 159
UTF-8 bytes, request ID beyond 39 bytes or more than six options stays read-only.
The contract is generated into Swift, Kotlin and C++ from TypeScript.

The 144-unit key renderer previously used 12–13-unit decision labels; choices
now use 22 units, up to three lines and explicit truncation. Ulanzi's WASM
renderer cannot rely on host font discovery: stage the existing canonical Korean
Regular/Bold faces and OFL license. Rendering different same-length Korean
labels through the production choice renderer produces different PNGs, checking
actual glyph coverage rather than font-file presence alone.

The prior physical Stream Deck and iPhone choice/approval acceptance remains in
[the CloudKit device record](docs/devlog/entries/2026-11-01-cloudkit-device-acceptance.md).
It proves native routing before this typography change; it is not physical
acceptance of every revised display. Firmware changes require native/simulator
checks and are not evidence of a hardware flash.

A capability-revocation simulator case caught a missing Focus Strip redraw key:
responses were refused safely, but restored delivery left the visible controls
stale. Include answerability in the frame signature. Knob native gates now take
precedence over any accompanying option array; the strip accepts only native
held permissions and leaves ordinary questions to a larger controller.

Local validation before integration: quick checks passed (7,115 tests); Android
JUnit/Robolectric passed; macOS Debug passed 1,407 tests with three skipped;
ESP32 host assertions and all 14 simulator builds/surface checks passed after the
redraw fix. Both companion production firmware targets built, and the portable
Ulanzi package passed resource/native-binary/archive checks (9.1 MB directory).
These are source/build results, not claims of new hardware installation.

A final boundary review found that session-option storage is 64 bytes although
serial transport can carry longer labels. A label beyond 63 UTF-8 bytes now
revokes compact answerability in both producers and the firmware's full-frame
fallback; the limit is generated and asserted against the actual C++ buffer.
Partial non-IPS10 rosters report their total with rotation explicitly false:
only IPS10's minute-based cohort policy can claim timed rotation. The first full
verification was stopped before these follow-up source edits and restarted on
the resulting clean commit.

The coverage run exposed test-only binary comparison overhead: deep assertions
on two 2.7 MB font buffers took 28.7 seconds and exceeded the 20-second test
limit. Native `Buffer.equals` preserves exact-byte verification without walking
millions of assertion nodes. All 7,115 tests then passed with coverage. The
interrupted run was stopped before editing the test; the clean full check is
rerun afterward.

Visual QA at the actual key canvas found that the 120-unit text measure split
`acceptance` into `acceptanc` and `e` at the new readable font size. A 132-unit
measure keeps `Deck / acceptance` as two complete lines inside the key. The
follow-up changes only the shared TypeScript measure, its renderer regression
and scope documentation; native executable sources stay unchanged.
