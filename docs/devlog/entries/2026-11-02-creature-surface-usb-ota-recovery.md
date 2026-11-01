# 2026-11-02 — Creature surface audit and NVS-preserving USB OTA recovery

The creature changes were frozen at `19636742`. Full verification passed in
37 min 51 s (26 automatic steps passed; Keychain E2E/Windows and the three
manual lab gates remain explicitly unverified in the receipt). The later
master integration `eaa1df40` passed quick and changed-area checks; its ESP32
tree is identical to `19636742`. The host review produced 532 images across
14 configurations and 38 scenarios, including actual IPS10 project rotation.

Deployment exposed a separate transport problem: 86 Box completed WiFi OTA in
142.1 s, but IPS35 and round AMOLED exceeded the 900 s client deadline while
still appearing on WiFi. A live socket was not treated as installation proof.
The supported daemon restart ended the remaining server-side transfers before
USB recovery. Serial suspension used expiring file leases across the restart.

For the five remaining boards, the installed ESP-IDF partition/OTA tools read
the live table and required byte equality with the verified build table. After
chip/capacity checks they wrote the inactive app and OTA selector only, retained
the other app, and verified the selector read-back. NVS, bootloader and partition
table were not flash-write targets. P4 was actually booting slot 1, so recovery
correctly wrote slot 0; guessing the current slot would have been unsafe.

P4 reads failed at 460800 baud before any app write. Resetting before each P4
tool invocation and using 115200 completed the operation. TTGO's app and selector
were hash-verified before a default serial reader failed to obtain its boot
identity; an app reader with explicit DTR=true/RTS=false recovered the response.
Do not infer bad firmware from that reader failure.

A final independent serial query confirmed all six boards running `19636742`
with build epochs inside their image-build windows, and every lease was resumed.
The persistent local evidence is under `diagnostics/surface-audit-19636742/`:
image manifest, full/post-merge receipts, write-range records and fresh running
identities. Host images and boot identities are separate from panel photography;
C6/D200X/XTeink physical screens and e-ink ghosting were not attested.
