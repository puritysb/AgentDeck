# 2026-10-31 — Installed development-signed Release relay acceptance

The [feature matrix](docs/appstore-feature-matrix.md#installed-signed-release-relay-acceptance-2026-10-31)
records the actual installation, numeric Tailscale connection, Keychain relaunch
and disable/relaunch results. This follow-up updated the development installation;
the earlier temporary Debug acceptance did not do that.

Release is a build configuration, while development/distribution is a signing
choice. The installed app previously used team QF36NDHYHD. Its matching existing
development identity/profile was retained for app-owned Keychain and bookmarks.
The Store archive verifier rejected the staged app only for a development
certificate; its remaining archive boundary checks reported no violation. No
new signing identity, profile or broader entitlement was created to turn a local
installation into a Store candidate. No version bump, tag, upload or submission
was performed.

The original install had no Store receipt and was backed up outside the installed
app directory. Its executable hash was compared again before the atomic swap.
The new install's hash matched the staged, strictly verified universal Release,
and its actual running process path was the installed path. The production app
was tested with typed temporary preferences and a verified temporary data root,
then kept installed while the original endpoint/posture preferences were restored.
A redundant holding copy was removed; the original rollback backup is retained
under the gitignored deployment diagnostics.

The full deployment check ran on clean commit 099da989. Standard macOS Release
and Debug validation completed before installation. Remaining platform checks
ran while the installed app acceptance was exercised, with GUI/helper activity
finished before the optimized macOS XCTest stage. All automated full steps
passed. The repository receipt uses UTC October 30; this installation occurred
on October 31 in Asia/Seoul. Unrelated lab attestations and platform/Keychain
opt-in checks remain explicitly unexecuted in that receipt.

Shared Node PID 6505, its build/posture, serial transports and device identities
matched the baseline after the updated app returned to shared port 9120. The
synthetic relay credential was disabled/deleted and temporary local/remote
validation files were removed. Local metadata, hashes, backup and runtime
receipts are under `diagnostics/relay-release-install-20261031/`.
