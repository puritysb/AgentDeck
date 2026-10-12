# 2026-10-12 — BLE permission diagnosis and bounded serial identity probes

Follow-up to [#517](https://github.com/puritysb/AgentDeck/issues/517) and
[#518](https://github.com/puritysb/AgentDeck/issues/518), after the 1.9.0 rollout.

## Measured cause and source changes

The actual TestFlight 7901 process's macOS TCC log records a Bluetooth code
requirement mismatch against the previous Development-signed app and a new
authorization prompt. Both native BLE transports logged `notDetermined`, then
reported only a powered-on timeout. The timeout now names pending consent,
denied/restricted access, or the observed adapter state, keeping existing bounded
retries. No privacy grant, signing identity, or configured device was changed.

The NM serial retry again returned no fresh identity. The earlier PySerial
probe had blocked in `flush()`/`tcdrain()`, which `write_timeout` does not bound.
The source helper now probes one port per bounded child, skips drain, retains
split JSON, and inspects only the requested port when one is specified.
Regression tests exercise stuck open/read/close followed by a responsive board,
split/noisy input, and malformed identity. These are host tests, not evidence that
the NM board was flashed.

## Hardware acceptance pending at initial diagnosis

At diagnosis time the Mac was locked, Timebox was absent from a fresh BLE scan,
and NM did not answer the leased 20-second serial probe. The user was asked to
unlock the Mac, power-cycle Timebox, and reconnect NM USB. Actual signed-app
handoff/rendering and NM's 1.9.0 boot identity remain pending those actions.
The normal Node owner remains running; iDotMatrix is connected. No NM erase or
flash was attempted. Submitted Apple build 7901 is immutable and does not include
these source changes.

## Verification record

[The clean-source receipt](verification/receipts/2026-10-12-38ca654.json) records
all 25 automated full-verification steps passing on `38ca6544` in 14m41s. This
includes coverage, Android, Apple Store and DotPreview configurations, ESP32
host/simulator/TTGO builds and clean npm installation acceptance. The three lab
gates remain unattested. Windows Node 22/24/26 passed separately in GitHub CI.

A later read-only USB-JTAG reset/ROM `read-mac` probe also received no serial
data. The NM continued to report fresh Wi-Fi telemetry with advancing uptime
and no reboot, while its serial entry remained explicitly `deviceInfoFresh:false`.
No flash/erase was attempted; the normal daemon's serial ownership was restored.
The new bounded reader itself returned without identity in 3.142 seconds on the
physical port. Physical reconnection and signed-app acceptance remain outstanding.

## Evening hardware acceptance after physical reconnection

The user subsequently confirmed Mac unlock, Timebox power cycling and NM USB
reconnection. Both configured BLE displays recovered under Node. Actual
TestFlight **1.9.0 (7901)** then took over: CoreBluetooth reported
`allowedAlways` / `poweredOn`, and both native modules connected and completed
new frame uploads. Swift served on 9121 during the existing bind cooldown,
reclaimed 9120 at 13:43:16 UTC and had both displays uploading again by
13:43:28 UTC. Swift → Node takeover also restored both displays with fresh
uploads and no errors. No privacy grant or configured BLE identity was changed
by the agent. The earlier pending-consent diagnosis is consistent with this
successful signed-app run; a new BLE implementation regression was not found.

NM's fresh leased identity response at 13:39:36 UTC identified `nm_epd_420` on
the re-enumerated USB path. The supported CLI installed the official
`esp32-v1.9.0` merged image, passed preflight and MD5 verification, and directly
read back **1.9.0 / 79061799** after boot. No erase option was used. A bounded
serial display-off/on exercise continued answering identity requests and
completed physical panel I/O; the normal daemon feed was restored afterwards.
A direct read without toggling USB control lines then reported an advancing
uptime of 246 seconds, 8 sessions, 12 timeline entries and 3 completed refreshes.
These are targeted transport, panel-completion and recovery checks, not a claim
of photographic color/button coverage or a full host suspend/resume test.

The supervised Node owner (`ee3f46e3890b`) and development Mac client were
restored; the serial lease is released. Issues #517 and #518 are resolved by
these targeted measurements. The earlier full-verification receipt stays
unchanged, including its unattested broad manual lab gates. TestFlight 7901
remains the submitted binary and does not acquire the later source fixes.
