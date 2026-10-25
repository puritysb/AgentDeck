# 2026-10-25 — Stream Deck CLI success precedes host handling

[Automatic deployment 40167510789](https://github.com/puritysb/AgentDeck/actions/runs/40167510789)
failed at 06:03:05.085 UTC after its 20-second plugin exit wait. The Stream Deck
host log first recorded the stop deep link at 06:03:57.695 and plugin termination
at 06:03:59.953: host delivery/handling was delayed, while the runtime exited in
2.258 seconds once the host handled the request. Its old receipt PID was absent
on the next read-only check. [The official retry](https://github.com/puritysb/AgentDeck/actions/runs/40167978317)
and [the following push deployment](https://github.com/puritysb/AgentDeck/actions/runs/40168108360)
both succeeded without a forced process kill.

Inspection of the installed Elgato CLI showed that stop/restart success means
macOS `open` accepted a deep link; it is not a host acknowledgement. Reissuing stop
on every short timeout was rejected: a queued duplicate can arrive after a new
runtime starts. The deployment instead submits each command once and retries
observation for a bounded 120 seconds, with progress every 20 seconds. Startup
requires a fresh receipt and a different PID from immediately before restart.
Only `ESRCH` proves a process has exited. An unknown installed runtime or an
unconfirmed restart preserves the installation and any backup instead of making
further lifecycle/file changes on an assumption.

The regression tests simulate 75-second delivery/startup delays with a virtual
clock, verify the deadline and single stop submission, and reject stale, dead,
mismatched and uninspectable runtime receipts. This models the incident without
stalling the shared Stream Deck host or its other plugins.
