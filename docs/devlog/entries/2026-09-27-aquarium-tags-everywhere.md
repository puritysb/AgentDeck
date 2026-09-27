# 2026-09-27 — Name-tag rule on every aquarium surface; floor residents spread apart

This entry records the rest of the aquarium name-tag work (DESIGN.md §6.4).

- **Android 2D habitat.** Each creature painted its own tag. Tags now go into a
  frame-scoped `CreatureNameTagLayer`, which `ColorRenderer` resolves with
  `resolveResidentLabels` after the last creature.
- **Android e-ink.** Translucency on paper would only produce dither noise, so
  e-ink takes the ordering half of the rule: priority tags paint last, and a
  colliding idle tag drops out. The queue is thread-local because e-ink frames
  render off the main thread.
- **ESP32.** Five creature files each hard-coded `sessionCount <= 4`. They now
  read the generated `TerrariumRules::NativeLabelDenseResidentCount`. The
  per-brand pill alphas (150/180) stay as board tuning.
- **Floor pile-ups.** The band layout allows neighbours to overlap by up to half
  a body. Swimmers are spread out by their waypoints, but idle octopuses all
  stand on one line, so two of them stacked into a single blob (seen on the Mac
  2D habitat). `spreadFloorResidents` (TERRARIUM_RULES.floorSpacing) now spreads
  floor-standing octopuses apart inside `[0.20, crayfish.clearMaxX]`. Verified on
  a running Mac 2D build: three idle octopuses, no body overlap.
- **Hand-mirror discipline.** The tag resolver (Kotlin/Swift) and the
  floor-spacing pass (TS/Kotlin/Swift) are hand mirrors of an algorithm. Each is
  now pinned by a shared vector file (`shared/resident-label-vectors.json`,
  `shared/floor-spacing-vectors.json`) that every implementation replays, and
  both are recorded as debt in docs/architecture.md.
- **"3D setting ignored" was not a bug.** `defaults read <bundle-id>` reads the
  sandbox container, while an unsigned debug build uses
  `~/Library/Preferences`, so the debug build fell back to the 2D default. The
  installed app reads `aquarium3d` correctly.
