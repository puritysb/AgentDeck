# 2026-10-18 — A live Dashboard socket can miss startup state

After the second host reboot, installed app PID 416 displayed “No AgentDeck
found on this network” while Node daemon PID 1771/build aff02020ec6d answered
health in 17ms. Read-only runtime inspection found transport status connected,
received-message true, retry attempt zero and fresh state data, but
DashboardState.bridgeConnected remained false. A manual reconnect to the same
loopback daemon restored the actual Collaboration graph without an app or daemon
restart.

The timestamps expose the initialization window: Node bound at 01:07:13.510 KST;
the app completed its WebSocket upgrade at 01:07:14.189; APME initialization
completed at 01:07:17.179, and startup completed at 01:07:18.118. The daemon
registers its initial-state callback after asynchronous module/APME setup. A
socket accepted before that registration never received the one-off connection
and initial roster events. Subsequent broadcasts kept the transport alive, so
its first-message timeout could not recover the missing initial state.

A real loopback regression connects before callback registration, receives a
startup broadcast, then requires the connection and roster snapshot after
registration. It failed against the deployed source because the callback was
never called. Registration now initializes still-open, previously uninitialized
clients once. Closed and unauthorized peers remain excluded; replacing the
callback does not replay already delivered snapshots.

This is separate from the fixed-version 10-minute measurement's two health
5-second timeouts and 34 native socket samples without ESTABLISHED connections
under host load 400–600 and memory pressure 4. Those observations and the
historical blank 3D scene still need separate acceptance; a reconnect or reboot
restoring the scene is not evidence that their causes were fixed. Private logs,
read-only debugger results and screenshots remain under ignored
diagnostics/dashboard-stability/runtime-followup-20261017/.
