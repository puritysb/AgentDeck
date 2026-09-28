# 2026-09-28 — Store submissions for the 1.6.0 release round

The remaining store uploads were completed through the authenticated consoles.
These are submission receipts, not evidence that the new versions are public.

| Channel | Submitted state |
|---|---|
| Apple iOS | 1.6.0, build 7501, Waiting for Review |
| Apple macOS | 1.6.0, build 7501, Waiting for Review |
| Google Play | Production 1.6.1 (23), full rollout and new 10-inch screenshots under review/automated checks |
| Elgato | 1.6 / package 1.6.0.0, Pending review; automatic publication disabled |
| Ulanzi | Review update replaced with 1.6.0; public version remains 1.2.0 until approval |

Apple's successful release workflow 36341623880 includes the exported archive
checks. Both platform records have English, Korean and Japanese What's New from
the corresponding 1.6.0 metadata JSON. Both retain automatic release on approval.
The iOS submission ID is `40351e77-874f-47a2-8cbd-f51ab480e439`.

Play's signed AAB was built with `./gradlew bundleRelease` from Android sources
matching `android-v1.6.1`; `jarsigner -verify` passed. SHA-256:
`6f06ce5edb9d22a6c475d3826af4f09b23ef1d61d6c6800bacae7ebc354e1a86`.
The console recognized versionCode 23, all three release-note locales, and a
100% production rollout. The four new 10-inch screenshots replace the old four;
phone and 7-inch assets remain. The final publishing overview includes both
the production release and screenshot change under review. Managed publishing
is disabled. Missing native debug symbols is a warning, not a submission error.

Elgato received the GitHub package with SHA-256
`9591a70706160ce2b18bd5ffbdaa62b1a29bb89ed4e1f54b2309c1752e2d3348`,
the new thumbnail, and all three renderer-generated gallery images. The downloaded
DRM-processed package has SHA-256
`182e750b8f96511b1d5ef92b309c27a4af583891ef77b2415feb7d14391d58a8`.
It installed, connected to the daemon, rendered live keys, and registered four
encoders in its runtime log. Physical rotation, press and touch verification
remains required before publication; do not publish the older 1.4 review entry.

Ulanzi's reopened review form confirmed version 1.6.0 and server ZIP
`77d778ac85f14dc6d276f5f1507b5c13.zip`. All seven locale summaries and descriptions
were restored and read back after the package upload. Dial is unselected. Cover
and banner 01 were replaced with 1.6.0 assets; outdated banners 02 and 03 were
removed. The uploaded source ZIP SHA-256 is
`dc63c6d6aa277d15e652d3493668eb5a82061eaeba10ebeabfac08eb4c5b1565`.

The local daemon was rebuilt and restarted through the supported lifecycle
command, verified healthy with build digest `414fd1850945`. The development
Stream Deck deployment passed with digest `c567fd57f78c` before DRM validation.
After the DRM smoke test, `pnpm plugin:deploy` restored the development link and
`pnpm plugin:check` verified that same digest (PID 86493). The encrypted package
installation was preserved by the deployment tool. Reinstall the downloaded
processed package for the pending physical test, then restore development again.

A four-hour heartbeat named **AgentDeck 1.6 스토어 릴리스 완료** follows review
results and remaining device gates. It reports meaningful changes only and must
not publish Elgato before physical validation or publish its older review entry.

Crema's initial 1.6.1 update is pending USB/ADB connection (only the Lenovo was
available). The official APK was downloaded and its SHA-256 verified:
`db2696016ab622b1ff3980c5a5cf1db849123b5a5ac676c9269420301ecc65b9`.
Preserve app data with an in-place update when the device is available.
