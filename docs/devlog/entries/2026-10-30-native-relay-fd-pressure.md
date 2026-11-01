# 2026-10-30 — Native relay verification under host file-descriptor pressure

The native relay implementation is in `c3458a65`; its contract and acceptance
scope are in [the feature matrix](docs/appstore-feature-matrix.md#native-daemon-relay-acceptance-2026-10-30).
The useful incident is the host failure, which the source diff cannot explain.

Xcode 27.2 / Swift 6.4.2 reported `Too many open files in system`, then misleading
missing-file/corrupt-PCM errors and empty `swiftc --version` discovery. The named
files still existed and the compiler version worked outside the failed build.
An unchanged ESP32 `lsof` listener probe also hit its five-second deadline.
Reducing build concurrency alone initially reproduced the failures.

Read-only process inspection found about 180,000 descriptors in a virtualization
helper and 30,700 in an unrelated filesystem search that had run over 11 hours.
That search was outside this task, so it was preserved pending explicit approval.
By the approved action's execution it had already exited; no signal was sent.
System descriptor usage fell from roughly 218,000 to 190,000. Neither global
limits nor other worktree files/processes were changed.

On the same committed source, all five native configurations then passed and the
unchanged listener-probe file passed all seven focused cases. The final complete
quick gate passed 7,029 tests with 17 skipped. Verification used
an invocation-scoped `xcodebuild -jobs 1`, Swift `-j1 -driver-batch-count 1`, and
`SWIFT_USE_PARALLEL_WHOLE_MODULE_OPTIMIZATION=NO` /
`SWIFT_USE_PARALLEL_WMO_TARGETS=NO`. These are dated local resource workarounds,
not project defaults or new required permission gates. Optimization stayed on
for Release/DotPreviewRelease. Actual native workers also survived a real
ping/pong before reconnect in the mixed Node/Swift socket fixture.

The shared daemon, installed app and connected hardware were not replaced.
Two-machine networking and signed relay Settings/Keychain acceptance remain
separate from these local process/socket and build results.
