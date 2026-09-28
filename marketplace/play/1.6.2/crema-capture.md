# Crema S captures — prepared for Android 1.6.2

These replace `marketplace/play/1.6.1/crema-0{1,2}-*.png`. The 1.6.1 captures show the usage row as `79%3d 9h`, the e-ink overflow fixed by #416 (#415).

Captured on 2026-09-29 on the physical Crema S (CREMA_0680S, Android 10, 1072×1448, density 300). Both PNGs are unmodified framebuffer screenshots (`adb exec-out screencap -p`). The app was a **pre-release build** of master `142f002c`: release-signed with the same certificate as the published APKs, and installed in place over the official 1.6.1 (app data preserved, version still 1.6.1/23). The device was restored to the official 1.6.1 APK afterwards (sha256 `db2696…`), with its `adb reverse tcp:9120` back to the host daemon.

The sessions are fictional, from `scripts/appstore-demo-orchestrator.mjs` on loopback port 19220 (without `--relay-usage`), the same source as the 1.6.1 captures:

- `crema-01-working.png`: working and idle sessions, Codex usage and habitat (cycle position ≈10.8 s).
- `crema-02-attention.png`: an approval request, other working sessions and a completed response (≈20.5 s).

**Before uploading with 1.6.2:** confirm that the Android UI did not change between `142f002c` and the release commit (`git diff 142f002c <release> -- android/app/src/main`). If it did, recapture from the released APK. The device clock reads 03:15 and 03:17 in these frames.
