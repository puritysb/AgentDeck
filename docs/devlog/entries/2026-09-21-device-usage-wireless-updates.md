# 2026-09-21 — Device usage layout and wireless Android updates

## Findings and implementation

The fleet review separated installed-version drift from renderer omissions.
IPS 10, TTGO, T-Display Pro, IPS 3.5 and round AMOLED still reported 1.3.0;
NM-EPD-420 reported 1.2.3 with no dual OTA partition. Publishing 1.4.0 had
not updated these connected devices. The following omissions also existed in
current source and therefore needed fixes before deploying newer binaries.

- **86box / IPS 3.5 / round AMOLED:** provider blocks now share a horizontal
  rail of compact horizontal fill gauges. Windows stack inside their provider,
  absent windows consume no space, and reset text remains visible. A GLM-only
  account now satisfies the outer panel visibility gate.
- **IPS 10:** the dedicated top bar now includes z.ai using its generated brand
  mask and the existing percentage/reset gauge. Narrow orientation reduces
  decorative chrome; an absent Claude provider no longer consumes a block.
- **NM-EPD-420:** its separate glance renderer now counts and draws GLM credits,
  with five available credit windows fitting on the 400×300 panel. The TRMNL
  preview pin changes only because the shared source contains the NM branch;
  the mirrored TRMNL surface itself is unchanged.
- **TTGO:** the whole usage card fills proportionally behind its labels, instead
  of a barely visible three-pixel rail. All five windows fit both orientations.
- **T-Display Pro:** both landscape and camera/portrait usage paths previously
  wrote a fifth GLM row into four-element arrays. Five bounded entries and
  density-dependent row heights remove that overflow and overlapping rows.
- **iDotMatrix:** Node and Swift compact renderers now include a fresh GLM
  credit rail; the Swift device module also retains the typed z.ai payload.
- **Android e-ink:** credit rows explicitly name GLM and the provider summary
  includes it. The existing row-width budget preserves percentages; MCP keeps
  its quantity label rather than pretending to be a weekly credit limit.

## Wireless Android delivery

The new signed GitHub `sideload` build offers manual update checks, bounded
HTTPS downloads, SHA-256 verification, matching package/signature and strictly
newer version-code checks, followed by Android's own installation confirmation.
It does not silently install packages. The Play `release` build has neither
APK installation permission nor the direct-update entry point; it opens Play.
Both use the same device classification and dashboard source.

An older reader needs this version installed once via USB or its browser.
The previously documented Wi-Fi ADB path cannot bootstrap a device whose ADB
TCP listener is closed. Pantone and Crema currently refuse that connection;
the user was asked to connect USB while other verification continued.

## Verification

- Workspace build/typecheck and the full Vitest run: 4,669 passed, two skipped;
  the two initial failures were the new Android version's changelog entry and
  the NM source's preview pin. Both were corrected; all affected tests passed
  on the focused rerun, including the new GLM retirement/visibility case.
- Android: all 398 unit tests passed, including the final GLM label-budget
  case; signed sideload APK and Play AAB compiled. The Play merged manifest
  contains no `REQUEST_INSTALL_PACKAGES` and its update flag is false.
- macOS compile exited successfully; native deployment is separate from this
  build check.
- Firmware-renderer previews cover all providers, GLM-only, NM, TTGO portrait
  and landscape, IPS 10 and T-Display Pro usage. Native layout tests pass.
- Lenovo installed the candidate, checked the live release feed successfully,
  and rendered GLM in the e-ink projection. This is LCD-hosted e-ink UI evidence,
  not a claim of physical EPD refresh verification on Pantone or Crema.
- The updated local Node daemon reports build `94395e799c70`; the connected
  iDotMatrix frame has the blue GLM rail and its BLE module reports connected.

- Firmware builds pass for `box_86`, `ips35`, `amoled`, `ttgo`, `ips10`,
  `nm_epd_420` and `t_display_pro`. Local PlatformIO was restored to the CI pin
  (pioarduino 6.1.19) after the 6.2 environment failed to import SCons's Fortran
  tool during the IPS 10 SDK build; that build then passed.
- Final previews confirm the visible z.ai heading on round AMOLED and the
  filled TTGO usage cards. All changed firmware images are development
  candidates, not a newly published ESP32 release.
- PR #362's ten CI checks passed, including Android, ESP32 simulator, iOS,
  macOS, Windows native runtimes, full workspace tests and design regression.

## Hardware delivery receipts (2026-09-22)

The firmware was built before the source commit, so its embedded identity is
`1.4.0 / bcd37b4c-dirty`; implementation is preserved in `fb6e2ed8`.
86box and IPS 3.5 completed OTA. Round AMOLED timed out at OTA chunk 8;
the CLI's inherited no-reset USB handshake also failed. Espressif's default
reset connected successfully, detected a 16 MB chip (the SSOT image declares
8 MB, within capacity), and verified the merged image after writing. Its Wi-Fi
configuration was re-provisioned from the saved daemon settings afterward.

T-Display Pro's radio returned while serial was suspended, but OTA begin still
timed out. It and NM-EPD-420 received verified merged images over USB. Their
existing NVS partition geometry was checked against the new partition tables;
settings were backed up privately, restored and verified, then the temporary
backups were deleted. Fresh serial device information confirmed the new build
on all five boards. No blanket flash erase was used.

TTGO also completed OTA and reported the new build after reboot. The final
delivery status, including IPS 10, is tracked in
[PR #362](https://github.com/puritysb/AgentDeck/pull/362).
Pantone and Crema remain on their existing installs: Wi-Fi ADB refuses the
connection and neither has appeared over USB. Lenovo has the signed Android
1.4.1 (19) candidate. The public newer-APK download/install flow still needs a
future release to exercise end to end; live checks and local installation were
verified separately.
