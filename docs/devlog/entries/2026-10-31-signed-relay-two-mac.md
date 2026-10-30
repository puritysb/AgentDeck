# 2026-10-31 — Signed relay acceptance and isolation pitfalls

The [feature matrix](docs/appstore-feature-matrix.md#signed-daemon-relay-two-mac-acceptance-2026-10-31)
records the acceptance outcomes. The useful additional evidence is how full-app
isolation was established without interrupting the shared daemon or devices.

The installed GUI had no TCP listener or serial device handles; Node PID 6505
owned port 9120. The GUI alone could be quit while Node and its hardware stayed
running. A temporary copy of the already verified universal Release app was
signed with the existing matching development identity/profile and production
sandbox entitlements. No alternate retired bundle ID, new certificate, profile,
entitlement grant or installed-app replacement was used.

An automatic approval review rejected an initial launch because argument-based
isolation had not been proved. A standalone Foundation probe then showed that
`-prefs.daemonPort 19436` yields a String, whereas AppPreferences reads `as? Int`;
that argument would fall back to the normal port. The rejected launch did not
run. A signed, server-free helper instead backed up only the relevant own-app
preference keys, wrote a typed Int port plus Bool posture flags, and verified
them in a second process. With source evidence tracing these keys through
DaemonService and DaemonPosture, the next launch was approved. Actual health
confirmed port 19436, loopback-only and no device modules.

Direct executable launch followed by a computer-use app selection caused a
Launch Services relaunch without the temporary data environment. Registry
inspection caught the first full process using the normal app container. That
run was not counted as data-isolated acceptance. It did not own shared 9120 or
hardware. The final repeated acceptance used `open -n --env AGENTDECK_DATA_DIR=…`
with an app-container temporary directory and verified its daemon.json PID
against live health after relaunch. The app's ordinary container state was not
rolled back wholesale; only whitelisted preferences were restored, preserving
other work and cached state. No test session was posted until the temporary
registry had been confirmed.

Network acceptance used a private LAN IPv4 endpoint and an explicit SSH reverse
forward for the full loopback-only Swift hub. A signed component host also
connected using the MacBook's .local name. Numeric Tailscale CGNAT health probing
returned NSURLErrorDomain -1022 with the production ATS dictionary; this remains
a documented endpoint limitation, not a reason to weaken ATS. Hostname attempts
were not uniformly reliable before the test hub listened on both IP families;
that sequence does not establish a production DNS defect or its root cause.

Final teardown restored own-app endpoint/posture preferences, removed the test
Keychain record, closed all owned local/remote workers and SSH forwards, removed
temporary signed apps, and re-registered/reopened the original development GUI.
The shared Node PID/build/posture and connected hardware identities matched the
baseline. Raw local receipts remain gitignored under
`diagnostics/daemon-relay-swift-20261030/`; synthetic tokens are not credentials
for the shared daemon and no real credential was included in committed evidence.
