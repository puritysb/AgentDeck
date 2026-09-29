# 2026-09-27 — Voice reboot diagnostics and e-ink interval counters

IPS10 rebooted after a spoken OpenClaw invocation. The daemon observed uptime
5267 → 5 seconds with reset reason software (3) at 2026-09-26T15:26:04Z.
A later direct serial capture completed upload and reply playback normally;
that single successful turn does not resolve the intermittent reboot.

The serial panic matcher incorrectly treated the normal I2C codec register dump
as a CPU crash. It now requires the CPU register-dump marker. Normal serial
ownership also retains an explicit allow-list of numeric voice milestones
(wake detection, endpoint, upload status/heap and playback counts), without
transcripts, session targets, endpoint addresses or credentials. This avoids
changing the active serial transport simply to collect the next voice trace.
It is diagnostic improvement, not a firmware crash fix.

## E-ink measurement for #272

Compared the release baseline with fresh serial telemetry on the same firmware
and advancing uptime. The observation interval is approximately 99 minutes;
wall-clock and uptime intervals agree within the existing reporting cadence.

| Board | Interval seconds | Repaint delta | Full refresh delta |
| --- | ---: | ---: | ---: |
| TRMNL 7.5 | 5911 | 20 | 12 |
| LilyGo EPD47 | 5934 | 18 | 4 |
| NM-EPD-420 | 5912 | 9 | 9 |

These are device counter deltas, not server broadcast attempts, successful
visible-frame verification, or a controlled before/after benchmark. Cumulative
telemetry does not contain individual repaint timestamps, so refresh-interval
percentiles and image survival times remain unavailable. No claim about
representative approval traffic is made. Local sanitized evidence is retained
under diagnostics/eink-measurement-2026-09-27.json in the main checkout.
