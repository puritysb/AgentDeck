# 2026-10-14 — Daemon relay: a worker daemon publishes its observed sessions to a hub

Remote attach was the last #273 gate with no daemon-first candidate. Before
building one, the original implementer of remote attach was asked on Discussion
#278 about his topology, which controls he uses remotely, and whether a Windows
console-input path or tmux on Linux workers would cover them. Nothing on the
managed remote path changes.

The relay is additive and experimental. `agentdeck relay set <host[:port]>`
writes `relay.json`, and the worker's daemon then dials the hub, sends
`relay_hello`, and publishes its observed `sessions_list` rows (`relay_sessions`).
The hub merges them as observed rows and routes deck commands for those
sessions back down the same socket (`relay_command_down`). The worker re-checks
each command against an allow-list and the set of sessions it is currently
relaying. It keeps the remote-attach boundary: opt-in, outbound only, token for
a non-loopback hub, and a capability bit (`daemonRelay`) the Swift daemon does
not advertise.

`tests/e2e/daemon-relay.e2e.test.ts` runs two real CLI daemons on loopback. A
deck permission decision and prompt sent to the hub arrive in the **worker's**
OpenCode steering queue, and the hub's own queue stays empty. With the hub's
routing disabled, that case fails while the other three pass. Not yet measured:
two machines, an `ssh -L` forward, and a Windows worker. Observed sessions on
Windows still have no terminal-injection path; the console-input candidate is
unmeasured. Details are in [docs/daemon.md](docs/daemon.md#daemon-relay-worker-daemon-to-hub).
