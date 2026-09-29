# 2026-09-21 — Final 1.4.0 delivery and store status

### Verification and runtime

The npm release source is `981512a69b281304e001c40148c7ee7c8174664f`, including
Luna quota recovery and the socket/launchd handover corrections. All four
packages were packed from a clean checkout and installed through the real
`agentdeck` command. Installed build: `e68b082d57bf`. The coordinated Mac test
app was 1.4.0 development build 4, using the Apple source submitted as 7001.
This does not claim runtime testing of the App Store-signed archive.

The three-mode gate passed: CLI-only and Swift-only direct Codex turns reached
the Lenovo tablet's visible completed timeline; the Mac app also observed the
Swift turn. Coexistence attached the app to the CLI, recovered Swift on 9120
after CLI stop (~145 seconds including the existing failed-bind cooldown),
and returned to CLI with the app automatically attaching again. Hooks were
not reinstalled during handover. [Measured receipt](https://github.com/puritysb/AgentDeck/issues/314#issuecomment-5761721871).
The earlier overlapping restart experiments are superseded by this controlled
verification. Port recovery is automatic, but not instantaneous.

### Channels

- npm 1.4.0 is public: all four exact versions, latest dist-tags and gitHead
  `981512a69b281304e001c40148c7ee7c8174664f` were read back from the registry.
  Setup README is populated (3,683 characters). The installed runtime remains
  build `e68b082d57bf` on 9120 with the Mac app attached as a client.

- npm publication was accepted for all four packages on the first attempt.
  The first readback timed out while shared was propagating. The retry skipped
  visible packages, but bridge was still staged and npm returned E409 rather
  than allowing a duplicate version. Keep the original tag and source; retry
  completion only after the exact bridge version becomes readable. It did
  become readable, and final workflow completion was retried without changing
  the tag or any immutable package. The release procedure now records this
  distinction and links npm’s publish-time scanning notice.

- Web flasher: Pages run 35606209752 was rerun after firmware publication.
  Public `flash/fw/index.json` now selects `esp32-v1.4.0`; the public manifest
  reports 12 boards. All five boards currently offered by the browser flasher
  remain the configured supported subset.

- ESP32 1.4.0: public release, 12 boards and 62 assets. All 60 binary sizes and
  SHA-256 values matched both the manifest and SHA256SUMS. Release workflow
  35601175941 succeeded after the hybrid builder correction.
- iOS 1.4.0: App Store Connect reports READY_FOR_SALE.
- macOS 1.4.0: WAITING_FOR_REVIEW, automatic release after approval; 1.3.2 live.
  Both Apple states were checked independently by read-only workflow 35608871052.
- Google Play 1.4.0 (18): full production rollout under review, managed
  publishing disabled. No further submission action pending locally.
- Elgato 1.4: Pending review. Keep automatic publishing off until the processed
  package's encoder check; 1.3 remains public.
- Ulanzi 1.4.0: the existing review item contains the new update notes and
  remains under review; 1.2.0 is the last verified public version.

### Handoff

Store review decisions are external and must not be described as completed
public releases. After approval, verify macOS and Play availability separately;
for Elgato verify the DRM-processed encoders before publishing. Ulanzi should
continue using the existing review item. No additional reporter email was sent.
