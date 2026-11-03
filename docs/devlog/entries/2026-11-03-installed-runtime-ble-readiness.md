# 2026-11-03 — Installed-runtime checks exposed BLE readiness drift

The local development install of source `a37e87ab` was checked independently of
the source/CI receipts. The running Node content identity was `c15944acfcfa` and
the Stream Deck plugin receipt was `aaf935279dd5`. The installed macOS executable
matched its freshly built executable by SHA-256. These are local development
receipts, not public package or Store delivery.

The deployment's ordinary LaunchServices open initially reused an active XCTest
copy with the same bundle ID. It returned success without creating a process at
the installed application path. No new crash report appeared. Starting the exact
installed copy as a new background instance recovered it without terminating the
other task's test host. Process-path and binary checks, rather than `open`'s exit
status, established the installed runtime. The real Pairing settings and its
confirmation dialog displayed the active-owner/incomplete-global-revocation
policy; cancellation performed no rotation command.

The Dashboard then exposed an unavailable optional BLE runtime. `ble setup`
reported ready, but a subsequent installation from the current requirements
actually upgraded **Pillow 12.3.0 to 13.0.0**. Imports had succeeded before that
upgrade. This demonstrated that renewing a requirements hash after an import
probe did not prove the declared versions had been installed.

The [managed runtime](bridge/src/python-ble-runtime.ts) now requires a versioned
ready marker from a completed installation. Changed requirements and old
unversioned markers trigger explicit repair; readiness is revoked before repair
so a failed pip step cannot report success. A managed environment cannot silently
fall back to a legacy checkout during that repair. Legacy-only checkouts and
explicit interpreter overrides keep their compatibility paths. Daemon startup
still performs no Python execution or network installation.

The repaired native arm64 environment contained bleak 2.1.1, Pillow 13.0.0 and
idotmatrix 0.0.9, and `pip check` passed. A supported daemon restart restored both
configured BLE panels to connected with no module error. The restart log also
recorded a Swift stand-down before Node resumed ownership; this was ordinary
handover, not a retirement/re-pairing test.

Camera inventory found two devices but video authorization was not determined.
No camera recording or optical e-ink acceptance is established by these checks.
