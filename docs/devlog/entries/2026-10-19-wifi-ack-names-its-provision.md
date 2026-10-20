# 2026-10-19 — ESP32: a Wi-Fi ack names the provision it answers

**What changed.** `wifi_provision_ack` now carries the `credId` of the
provision it answers, and both daemons use it to decide whether an ack is the
latest provision's result. The firmware echoes the id only in its own shape
(16 hex characters), so a malformed field cannot crowd the 256-byte ack line.

**Why the count was not enough.** [The Wi-Fi setup route](docs/devlog/entries/2026-10-19-esp32-wifi-setup-through-the-daemon.md)
kept an ack only when no later provision was still owed one, because the
board named no provision. The count starts with the connection, so it cannot
place an ack for a provision written before it began: a provision from the
other daemon, from before a daemon restart, or one whose ack outlived the
30 s timeout. Each of those was taken as the latest answer. With ids on both
sides the match decides, and a mismatch leaves the latest provision owed.

**Rule.** `wifiProvisionAckAnswered` in `shared/src/esp32-wifi-provision.ts`,
generated into `ESP32WifiProvisionRules.generated.swift`. The ids decide only
when both the latest provision and the ack carry one; otherwise the old count
decides, so firmware that predates the echo behaves exactly as before.
`shared/esp32-wifi-provision-vectors.json` pins both paths for both daemons.

**Known limit.** Two provisions with the same credentials carry the same id,
so the earlier one's ack is kept until the later one's replaces it. Both
answer the same credentials.

**Not covered.** No board has been flashed with the echo. The firmware change
was compiled, not run; see the PR for the environments.
