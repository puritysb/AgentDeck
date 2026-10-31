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
