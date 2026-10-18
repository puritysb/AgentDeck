# 2026-10-18 — An absent BLE panel made its sync client respawn every 96 s

The Node daemon's `/devices` showed the Timebox Mini at `connecting…` with no
frame ever pushed. The daemon log's hourly summaries for its sync client added
up to 915 respawns in 24.4 h (37.5 an hour). Every exit was `code=0`, with a
stderr tail of two `BLE connection error: Device with address … was not found`
lines.

The client's own exit message never reached the log. `should_exit()` gives up
when the daemon has not answered for `BRIDGE_GONE_EXIT_SEC` (30 s), but its clock
advanced only from bridge fetches made while the panel was connected. With the
panel absent, two failed scans later the client decided the daemon was gone,
printed `Bridge unreachable >30s` to stdout and exited 0. The supervisor's exit
line shows only the stderr tail. It respawns after a delay that grows by 5 s per
exit and holds at 60 s (a code-0 exit never resets it, by design for exactly
these "device not found" exits), so the steady cycle was about 36 s of scanning
and 60 s of waiting: the measured 96 s. This is the same class as 2026-07-02,
when the iDotMatrix client starved the same clock on its host-asleep path. That
fix covered that path only, and this loop's log lines were squelched as "device
off".

The fix probes the daemon after each failed attempt's pause, so only a daemon
that stopped answering runs the clock out, in both clients. Retrying in-process
needs pacing: every attempt is a full BLE scan (bleak finds the address by
scanning), and the old fixed 3 s pause would have scanned almost without a
break. The pause now doubles from 3 s to 30 s and resets on a connection, which
keeps an absent panel's scan time near what the respawn cycle cost.

Pitfall: the probe has to come after the pause. The production cap equals the
30 s window, so a probe taken before pausing lets one capped pause run the clock
out by itself. The new suite (`bridge/ble-worker-tests/`, run from
`ble-worker-absent-panel.test.ts`) shrinks the window below the cap to pin that.
It fails both with the probe removed and with the probe moved before the pause.

The respawns were also doing a job nobody had written down. The iDotMatrix
supervisor reads the configured device when it spawns the client, so an absent
panel's exit-and-respawn cycle re-read the settings every minute or two: a panel
re-paired with `agentdeck idotmatrix remove`/`add`, which says nothing about
restarting the daemon, took effect on its own. Now that the client stays up, the
supervisor re-reads the settings every 30 s while the panel is not connected. It
restarts the client when the device changed and stops it when the device was
removed. Two traps on the way:

- `loadIDotMatrixDevices` folds an unreadable settings.json into "none
  configured", and the file is rewritten in place. Acting on that empty list
  would stop a healthy client on a read that landed mid-write, so the recheck
  reads through `readIDotMatrixDevicesStrict`, which returns null instead.
- The reload-on-change branch the recheck reuses had never run with a live
  child: its only caller ran after auto-discovery, when nothing had been
  configured. The replaced child's exit would have scheduled a respawn that
  orphaned its successor, because the restart clears `stopping` first. The exit
  handler now ignores a child that is no longer current.

The Timebox supervisor captures each device once per daemon run and its `add`
command tells the user to restart the daemon, so it needed neither.

Rejected:

- **Leave the pacing to the supervisor's backoff**, as before. Its 60 s cap
  already spaced the cycles, but each one still started a new Python process
  and the client still reported a dead daemon. The new pacing also finds a
  returning panel sooner: within about 45 s, where a panel switched on just
  after a scan used to wait out the 60 s respawn delay first.
- **Exit with a distinct code for "panel absent".** That needs a new supervisor
  policy and keeps the process churn.
- **Recheck the settings for a connected panel too.** A brightness edit would
  then restart a working panel, which the respawns never did: a connected
  client never exited.

Not established: why the Timebox is not advertising. `log show` returned nothing
usable for bluetoothd. A scan from an agent shell risks a Bluetooth consent
prompt or a SIGABRT under another responsible process, so none was run. Running
`agentdeck timebox scan` from a terminal that has Bluetooth access, or checking
the device's power, will tell.
