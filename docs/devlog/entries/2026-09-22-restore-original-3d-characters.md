# 2026-09-22 — Restore original character identity in 3D

- User explicitly rejected the new aquatic animals: 3D must preserve the original characters. Removed substitute bodies, googly eyes, fins, tentacles and chest badges.
- Full-size canonical SVG silhouettes/faces/colors again define every character. Restrained thickness and a rear closure within the original outline replace the unrelated back anatomy. Claude's original arms/four feet and OpenClaw's original claw paths receive pivots; no new limbs are invented.
- Retained non-bobbing contact/state motion, fixed substrate, native picking and fish reactions. Removed runtime branches specific to the rejected anatomy.
- Blender front/back review and macOS installation verify restoration. Native identity regression rejects substitute anatomy and checks original Claude proportions/four feet, alongside contact/state/motion coverage. macOS/iOS builds and workspace checks run; iOS not physically deployed and no store release.
- Validation: 31 focused XCTest cases pass; macOS/iOS builds pass. Full Vitest passes 4,671 tests (2 skipped) with one worker. Parallel runs twice hit the existing live-loopback test’s unsafe assumption that `port + 1` is unused; the isolated file also passes. No unrelated test code was changed.
- Durable design constraint recorded in the asset README: preserve the original full character, never substitute a different animal wearing its logo.

See [native asset notes](assets/terrarium/README.md#native-3d-residents-apple).
