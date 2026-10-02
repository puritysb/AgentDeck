# 2026-10-02 — Hermes mermaid: likeness, motion and laptop state cues

### Problem

The bundled Hermes mermaid still read as "not her". In profile her eyes were
front-projected drawings. The app's sun washed out the painted face and drew
heavy shadows. She tumbled side-on as she swam, and she did not look like an
agent. Once she held a laptop, the waiting and error states looked identical
to idle.

### Solution

The head is rebuilt by measurement in `assets/terrarium/hermes-head/`. The
pass log is `assets/terrarium/hermes-head/NOTES.md`.

**Model:**
- 3D eyes are cut into the face (`eyes3d.py`); the cut-out faces are reused
  as the closed lid.
- The face is flat-lit: albedo 0.35 plus a texture-coloured glow.
- The bob is fitted to the sheets, with a flared hem, two-tier flips, the
  Nous shine band and clasps at both headband ends.
- The hair is near-neutral black.

**Motion (`HermesSwim`):**
- She leans into her travel head-first; yaw is capped so she no longer turns
  side-on.
- Her head counter-rotates toward the viewer. She floats softly, curls her
  tail at rest and twirls once when work completes.

**Agent:**
- She holds a laptop that carries the canonical `design/brand/hermes.svg` as
  a sticker, and she swims at 1.35× the shared resident size.
- Waiting turns the laptop round to show an amber `--status-awaiting` screen.
- Error sags the lid shut with her head bowed.
- The rig manifest gains two additive controls, `laptop` and
  `hermes_laptop_lid`.

### Pitfalls

- **RealityKit black pixels.** Single pure 0/0/0 pixels come from sliver
  triangles (a bevel modifier's narrow strips) or from interpolated normals at
  lighting terminators. Material settings do not move them. Check the
  triangles' minimum angle, then try flat shading.
- **Glow strength in USD.** Blender's USD export drops Emission Strength for a
  textured emissive. Write it as the `UsdUVTexture` `scale` input after
  export; RealityKit honours it.
- **Cues hidden by a prop.** An arm-raise cue went up behind the laptop. Judge
  state cues on rendered frames, not on pose numbers.
- **On-device measurement.**
  - `xctrace --attach` could not find a process that `devicectl` had
    launched. Use `xctrace record --launch` over USB.
  - The Game Performance template kept only about 8 s of GPU intervals.
  - The phone's auto-lock silently fails launches.
- **Rejected direction.** Longer hair with one big C-curl turned the bob into
  a shapeless block, and a black curl vanishes against dark water.

### Verification

- HermesAquariumTests pass (10/10, including a waiting-laptop test on the
  bundled model).
- `pnpm build`, `typecheck` and `test` pass: 5073 tests.
- The iOS build passes.
- On an iPhone 14 Pro Max at thermal state Serious, Hermes held 57-60 fps
  (frame-interval p99 29 ms).

PR #427.
