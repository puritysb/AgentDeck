# 2026-09-28 — Refresh public device photography

The README, Pages landing page, and Devices catalog now use the September 28
real-device photographs supplied by the project owner. Eighteen selected camera
sources are archived upright at full resolution with EXIF/GPS metadata stripped;
the crop table reproduces all public JPEGs. Three near-duplicate captures were
omitted. Dedicated older shots remain for TRMNL, TTGO, XTeink, T-Embed, and
Waveshare where the new set has no clearer replacement.

- Updated 18 existing photo outputs and added four views: the full portrait desk,
  Crema S, macOS on a monitor, and the TC001 usage page. The foreground hero links
  to the full desk. The Apple and Android guides show actual photographed devices.
- Square and portrait panels retain their complete screen and bezel on a dark
  stage. Mobile catalog cards contain the image; the wide Stream Deck family
  follows its image aspect ratio so neither deck is clipped on a narrow screen.
- Source mapping and selection notes live in
  [the capture archive](assets/hardware-photos/README.md); coordinates live in
  [the crop generator](scripts/crop-hardware-images.mjs). Regeneration now exits
  unsuccessfully if any expected crop is missing, invalid, or fails to encode.
- Screens, reflections, and photographed state are preserved. The macOS crop
  excludes the unrelated App Store Connect table below the dashboard.

Validation: all 27 generator outputs written; source metadata removal checked;
`pnpm build`, `pnpm typecheck`, and `pnpm test` passed (326 files, 4,912 tests,
2 skipped). Protocol regeneration left no drift. Token, navigation, hardware
spec-card, docs, and design-system checks passed; the design-system viewer built.
Design lint on tracked sources remained at its 89-violation baseline. Browser
review covered the desktop catalog and landing page plus a 390 px mobile catalog;
no horizontal overflow or broken loaded images, and both decks remain visible.
