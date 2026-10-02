# 2026-10-03 — Platform publication and release readback

The user authorized releases outside the App Store wherever ready. Read each
channel independently; no common version bump was inferred.

| Channel | Measured result |
|---|---|
| Elgato | Published the approved 1.6 row from Maker Console. Public Marketplace shows Version 1.6, Oct 3, 2026, 758.41 KB and the 1.6.0 notes. The 1.4 review row was not released. |
| Ulanzi | The published-work record and public `/contentView/1141` both show 1.6.0, AI, Windows/Mac, D200/D200H/D200X without Dial. No upload needed. |
| Google Play | 1.6.1 is public. Submission 11 (production and listing changes) is Released; no pending publication in the overview. Public screenshot comparison remains open. |
| npm | Registry queries return latest 1.6.0 for hooks, shared, bridge and setup. |
| ESP32 | The 1.6.0 GitHub Release has firmware, merged images, manifest.json and SHA256SUMS.txt for the shipping board set. This is artifact delivery, not a new hardware verification. |
| Apple | Release run 37077566610 succeeded for both 1.7.0 archive verifiers and uploads. Neither platform was submitted for App Review. |

Elgato's physical acceptance was already satisfied by the owner's confirmation
recorded in the [1.6 submission receipt](docs/devlog/entries/2026-09-28-store-submissions-160.md#follow-up-physical-confirmation-and-crema-captures).

All non-Apple targets have changes since their last delivery, including shared
Hermes integration. A new release from current master remains contingent on
[real Hermes lifecycle verification](https://github.com/puritysb/AgentDeck/issues/426),
[visual acceptance](https://github.com/puritysb/AgentDeck/issues/428) and relevant
[device/control-path validation](https://github.com/puritysb/AgentDeck/issues/425).
The [Hermes release conditions](docs/hermes-agent.md) are not waived by passing CI.
No non-Apple source version or release tag was advanced in this readback.

Android's pre-release Crema screenshots were captured at `142f002c`; current
Android UI differs, so their provenance requires recapturing from the next APK.
The existing 1.6.1 listing was not replaced with images of unreleased code.
