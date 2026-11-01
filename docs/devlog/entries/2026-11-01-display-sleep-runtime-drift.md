# 2026-11-01 — Display sleep detection was healthy; downstream state had drifted

The shared Node daemon correctly reported `displayOn: false` throughout a
14-second `pmset displaysleepnow` run and returned true after display wake. Its
`pmset -g powerstate IODisplayWrangler` fallback failed on this OS, but the
persistent CoreGraphics probe still worked. Replacing that detector would not
have fixed the reported devices.

The actual Lenovo foreground package was the retained `dev.agentdeck.qa180`
installation, not `dev.agentdeck`. Its log received display-off but explicitly
refused dimming because that package lacked WRITE_SETTINGS. After the user's
explicit permission to restore it, measured brightness followed 125 → 0 → 125.
No APK or private application data was replaced.

Pixoo's existing `192.168.68.110` Tide entry existed only in the Swift profile;
the active Node profile had no device entry and no active Pixoo module. With
explicit authorization, only that entry was restored to Node and the same build
was restarted once through its launchd lifecycle command. Pairing-token hash,
network posture and all eleven USB connections were retained. Direct Pixoo
configuration reads then measured brightness 100 → 0 → 100.

The hardware test also exposed misleading diagnostics: Node's module-health
projection hard-coded `displayDimmed: false`. The source now projects the live
Pixoo bridge state. Health inspection must not render a preview frame as a side
effect. This source correction is separate from the installed runtime repair.

Pantone requires a separate check: Android brightness writes reported success,
but the actual `/proc/aw99703/led_brightness` register remained 1081 while sysfs
brightness read zero. A filesystem-mode check cannot establish app access; the
[earlier SELinux investigation](docs/devlog/entries/2026-03-20-03-display-dim-e-ink-pantone-6.md)
already demonstrated that distinction. A permission-free, separate instrumentation
fixture was prepared to test the ordinary app context without replacing AgentDeck.

The authorized fixture confirmed that this Android 14 firmware permits ordinary
app procfs writes, but physical acceptance disproved that route: both channels'
cached values changed while their hardware registers did not. The old driver
debug flags were restored after bounded interface checks; no debug or raw-register
path is part of the product fix. The fixture was removed.

The current manufacturer's launcher and `android.os.LightUtils` implementation
identify `light_current_mode` and the per-mode brightness/warmth/status keys as
the actual Android 14 contract. Both LED engines changed from backlight to standby
with mode 1, and returned with the original mode 4. The retained brightness register
is not evidence that an engine is still on: its operating state is register 0x02
bits 1:0, per the [manufacturer's datasheet](https://doc.awinic.com/doc/202403/4635fa96-003b-4dd8-ad18-b47173a9429f.pdf).
The app already held WRITE_SECURE_SETTINGS; this route adds no permission or root
requirement. Private durable recovery precedes mode/preset mutation and failed
restoration retains the journal. The procfs-only candidate was replaced by this
mode controller rather than shipped as a successful fix.

Final in-place signed-APK acceptance kept the original package's certificate,
permission set, data and rotation. Host display-off changed mode 4 → 1 and both
LED engines' low mode bits 1 → 0; wake restored mode 4 and both engines to 1.
The first observed off sample was approximately ten seconds into the run, within
the existing 15-second WS re-sync cadence, not an instant-response claim.
The complete vendor preset table matched the pre-test snapshot afterward.
On this ROM `Settings.Global.putString(null)` leaves a null-valued row; the
adapter uses public `ContentResolver.delete` to restore a previously absent key.
Android's 550 tests and the scoped Android pre-release receipt pass; Quick passes
7,187 cases with 17 skipped. This is a local same-version/code verification build,
not a published Android release. The shared Node process was not restarted again.

### Follow-up: separate actual display timing from the request and repair cadence

The earlier ten-second sample had no independent timestamp for the Mac actually
going asleep. It cannot establish that the 15-second repair timer caused that
delay. Initial follow-up runs had no sleep transition, or only a roughly 440ms
CG sleep pulse that the running daemon's two-second poll missed. Do not count
those as a sustained-sleep latency result.

After the operator left input idle, the unchanged shared daemon/Pantone path
measured CG asleep → WebSocket off in 49ms → both LED engines off another 100ms
later. On wake, CG awake → WebSocket on took 1,446ms, then LED power returned
after 182ms. Thus the ten-second delay was not reproduced; the measurable host
delay is consistent with the existing two-second sampling interval. Hardware
readback is sampled, so these are observed bounds, not exact actuator timings.

Node now samples CoreGraphics every 250ms, resolving the main display each time,
and ignores retired helper stdout/exit callbacks. Swift uses public workspace
screen sleep/wake notifications, keeps its two-second repair probe, subscribes
before initial sampling and removes/fences display observers on stop. No
permissions, Android data or frontlight recovery semantics changed.

The signed Sandbox Release derivative (executable SHA-256 prefix
`ad89bd42f6de`) and isolated CLI passed display-only sleep/wake in all three
configurations. Independent 25ms CG sampling and nonblocking measurement commands
gave off/on edge-to-wire times of Swift 10/381ms, Node 2/2ms, combined 85/45ms.
An earlier measurement used synchronous wake commands and was discarded because
it could delay both observer callbacks and hide latency. The final runner uses
source timestamps and also pairs genuine early wake edges with their preceding
sleep rather than mistaking them for missing commanded wakes.

The shared daemon remains PID 12363/build `8fe2909f2930`; its running helper still
uses the old two-second interval. No installed-app swap, shared restart or physical
device redirection is included in this acceptance. Physical device acceptance in
each alternate owner configuration remains separate from these wire receipts.

Quick passed 7,188 tests (17 skipped); macOS XCTest passed 1,476 tests (five
skipped). The scoped pre-release receipt records only the local arm64 macOS
Release/Dot-exclusion build, not a universal archive or all-platform release.
