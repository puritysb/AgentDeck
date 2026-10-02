# Hermes head blockout (2026-10-01)

This restarts the Hermes head from the big forms. It replaces the loop of
regenerating parts with formulas and tuning numbers by eye. Scope is the head
only: skull/face and one hair mass, in grey. Details, materials, body and rig
wait until the big forms pass the gate below.

## Method

1. `measure_refs.py`: extracts the face and silhouette contours from the
   candidate-02 front/profile panels into `ref/targets.json`. The mapping is
   1 unit = 100 px, the chin is at z = 0 and the face looks toward −Y.
2. `bootstrap_blockout.py`: **seeds** two low-vertex cages (head 209 verts,
   hair 383 verts). Every vertex carries `ring`/`col` attributes. Hair grows
   from the skull: above the bang line it follows the measured silhouette;
   below it, it drapes from the skull and hugs the cheek at the face window.
   Do not tune the seed to fix a shape.
3. `edits.json`, applied by `apply_edits.py`: the sculpt history. It holds
   ordered, mirrored vertex moves addressed by `(ring, col)`, each group with a
   note saying which comparison motivated it. Shape changes go here.
4. `review_blockout.py`, `compare.sh`, `score.py`, `facediff.py`: render at
   cameras pixel-registered to `ref/front.png` and `ref/profile.png`, overlay
   the reference contours (face in yellow, silhouette in cyan), and report the
   silhouette IoU and the exposed-face IoU. The three-quarter view is for
   judgment only; the master concept is not a calibrated camera.
5. `likeness_preview.py`: a diagnostic only. It uses solid hair and projects
   the reference front face from the front camera, to check whether the face
   surface holds when the view turns. It is never exported.

6. `refine_fringe.py` (runs after the edits): splits the mass's front rows
   into quarter columns and cuts the measured hem into the mass itself, with
   the V-splits at x ≈ −0.55 and +0.66. A separate fringe panel laid on the
   mass always showed a seam, so it was dropped.
7. `build_locks.py`: holds the lock design data. Locks are the framing locks
   plus a layered flick set on the front-side (|θ| 70–100°). Their control
   points are surface-relative (hair/head ray-cast, or cage vertices), roots
   are buried in the mass, and thickness follows the surface normal.
8. Master camera: `fit_master_camera.py` fits yaw, elevation, roll, scale and
   shift to the master concept. It scores face IoU, dome IoU and 2× facial
   feature IoU; silhouettes alone are flat over yaw 35–55°. The fit is yaw 32°,
   elevation 4°, flat over 28–36° / 0–8°. `run_master.sh <dir>` then renders
   the model there and overlays the master's contours (`master_overlay.py`,
   `master_metrics.py`).

Run everything with `sh run.sh <render_dir>`. Then run
`python3.13 score.py <dir>` and `python3.13 facediff.py <dir>` with Blender's
bundled Python.

## Status: v19 final (2026-10-01, after 25 fix-verify iterations)

The loop judges the INSTALLED model, not the grey blockout.
`sh iterate.sh <dir>` rebuilds the blockout, then v19 (preview build, not
installed), and renders it in two ways:

- **Blender:** at the fitted master camera and at the sheet's front/profile
  cameras (`master_look.py`, `look_compare.py`).
- **RealityKit:** face, three-quarter and master-camera views plus blink
  (`native_preview.swift`).

Measurement helpers:

- `master_rows.py`: per-row silhouette deltas at the master camera.
- `landmarks3d.py` + `solve_camera.py`: a least-squares ortho camera from 7
  hand-marked master landmarks (eyes, nose, mouth, chin, hem, clasp). The
  residuals show where the model disagrees with the master; the final RMS is
  15.5 px.

Final review sheet: `diagnostics/hermes-mermaid/nous-v19-final/review-final-v2.png`.

What the loop changed (E14–E30 in `edits.json`, plus the files named):

- **Hair volume:** larger (E14); the crown taller (E27); a smooth bell at the
  back (E17b, E29); the far side wider (E20); the curtains hug the cheeks at
  eye level (E28).
- **Fringe:**
  - It is one smooth sheet from crown to hem (E25). Before, it bulged at
    z 3.0 over a fold and read as a mushroom brim.
  - It sits closer to the forehead (E15, E23) and its hem is raised 0.14
    (`refine_fringe.py`).
  - The V-splits open (E24), and pointed lock tips run along the hem.
- **Face:** a longer lower face from the landmark solve (E22). The chin was
  then corrected in E26/E27; E23 had pushed it in front of the lips. The jaw
  tapers (E18, E26).
- **Right-side flicks:** broad crescent blades facing the viewer
  (`build_locks.py`). The left side is smooth, as in the profile sheet and
  the master.
- **Eyes (`face_v2.py`):**
  - Rounder eyes (h/w 0.70) with a heavy liner band.
  - One upper-left glint, as in the reference. It was mirrored before.
  - A soft lower iris crescent, a double-lid crease and fine brows.
- **Materials (`build-hermes-mermaid.py`):**
  - The hair is navy-black with low IOR (1.12). RealityKit's image light
    made any specular a flat grey sheen (median 59 vs the concept's 27;
    now 36).
  - The skin is warm ivory, measured in RealityKit at 241/231/222 against
    the master's 246/235/226.
  - The head joint is lower (.188), because the concept's chin sits almost
    on the shoulders.

Master-camera fit score: 2.19 → 2.40 (dome IoU 0.82 → 0.88, feature IoU
0.32 → 0.40).

## Face pass (2026-10-01): shading, nose, chin, neck

The review compared RealityKit renders with colours sampled from the front
sheet and the master. The concept's face is flat, lit ivory; its shading
lives in painted accents. RealityKit lights a near-white albedo almost flat,
so those accents are painted.

- **`face_paint.py`:**
  - Gives the face a small nose form: a tip, a bridge and a tucked
    underside. The grey hook-line nose decal is gone.
  - Bakes `face_shade.png`, an albedo texture front-projected onto the face,
    as ratios measured against the lit ivory:
    - a neck/chin shadow (228/202/187);
    - the jaw's underside;
    - a warm band under the fringe;
    - nose side shade and nostrils (230/207/195, 197/178/171);
    - the bridge contour;
    - warmer side planes and faint cheek warmth.
  - It is regenerated by every build and packed into the USDZ.
- **Chin (E31):** raised and widened into a soft U; it had read as a V.
- **Neck:** the painted face neck (`NECK_R`, 0.05 m, the concept's ~42% of
  face width) now carries the visible neck, just outside a thinner body neck.
  Before, the body's shoulder ring covered it.
- **Lips:** sampled colours (upper 140/128/130, lower ~205/185/182) and a
  fuller M-shaped upper lip (~0.008).
- **Iris:** smaller, darker top, soft lighter lower crescent.
- **Nose and mouth heights:** set halfway between the master solve and the
  front sheet.
- **Fringe:** thinner (Solidify vertex group, 0.35× at the front), and the
  hem is blunt with faint lock rhythm instead of a sawtooth.

Review sheet: `diagnostics/hermes-mermaid/nous-v19-face/face-review.png`.

## Hair topology pass (2026-10-01): hand-laid lock planes

- **`build_lock_planes.py`:** builds the visible hair as 16 roof-shaped
  locks:
  - 6 fringe locks ending in gentle points;
  - 10 curtain/back locks ending in pointed tips at the bob hem.
  Each lock is two long planes meeting at a raised ridge. Their corners are
  cage vertices, so the layout follows the sculpted flow grid. Seams are
  staggered and ridge heights vary, so the facets read as hand-cut. No
  Decimate/Remesh. This replaced the jittered diamond facets (grid look) and
  removed the ledge above the fringe.
- **Under-layer:** the cage becomes `hair_under`, the dark layer that fills
  the gaps. It is recessed 0.16 (Displace), because the big planes are chords
  across the curved cage and a full-size cage poked through mid-plane as dark
  diamonds.
- **Fringe:** thinner, through the Solidify vertex group in the seed.
- **Headset:** the centreline is smoothed over the faceted locks and kept
  clear of them, so it reads as a rigid band.
- **Right-side C-curls:** larger. They now emerge from the lock planes
  instead of under them.

Final review sheet: `diagnostics/hermes-mermaid/nous-v19-complete/complete-review.png`
(RealityKit, master camera, front/profile sheets).

Metrics at the end of the pass:
- Master-camera dome IoU: 0.875 → 0.916.
- Landmark RMS: 16.1 px (was 15.5).
- Feature IoU fell 0.40 → 0.27. It is measured by projecting the sheet onto
  the blockout, and `likeness_preview.Z_ANCHORS` predate the E31 chin
  change. Treat it as stale until the anchors are refreshed.
- 145k triangles; USDZ 7.2 MB.

## Nose and face pass 2 (2026-10-01)

**Review conditions.** The review renders now use the app's own lights
(`native_preview.swift` copies AquariumPreview's 5000 lx sun and 900 lx
fill). Every earlier RealityKit review used dimmer preview lights.

**Nose form (`face_paint.nose_form`):**

- Sized to the profile sheet: the tip stands proud of the cheek plane by a
  measured ~0.3 blockout units, with a bridge ridge from between the eyes, a
  tucked underside and a slight lip pout. The model tip sits at -1.51 against
  the sheet's -1.62 at z 0.9.
- The tip and bridge are joined smoothly, and the displacement is relaxed on
  the face's ~2.5 mm grid, so the tip is a rounded wedge, not a cone.
- The face is triangulated in the builder, choosing the better diagonal.

**Nose shading.** Painted at the sheet's measured size and strength. The wing
shade and nostrils are stronger, because the app's sun washes painted
accents out. The bridge has a light strip instead of dark side lines.

**Eyes.** The dark layer is the iris's upper ~60% (the sheet has no distinct
pupil). The brows are finer.

**Chin.**
- E32/E33: moved back to the profile sheet (it now matches within 0.04 from
  z 0.1 to 0.7).
- E34: a soft point, not a broad U (front width at z 0.1: model 1.02, sheet
  0.96).

**Skin albedo.** Lowered so the app's sun no longer clips the face to white
(median 244/234/225 vs the master's 246/235/226).

**Dead ends (the reason is in the code comments):**
- Local subdivision around the nose: it left dark single pixels in
  RealityKit.
- A normal-keyed side-plane shade: it rendered as stepped bars.
- `max(tip, bridge)`: it left a V crease.

**Known artifact.** One sub-pixel dark dot at the nose tip remains in
RealityKit renders. It is not in the mesh (no folds, no open edges, normals
and winding consistent in the exported USD), not in the texture, and not in
the material (it persists with a plain material). It is invisible at
aquarium scale.

Review sheet: `diagnostics/hermes-mermaid/nous-v19-nose2/nose-review3.png`.

## Jaw pass (2026-10-01)

**Diagnosis.** The user saw "too much flesh under the chin" and odd shading
on the lower cheeks. The concept's jaw is an edge: the lit cheek planes turn
sharply into a shaded underside, and the neck below sits in shadow. The model
had a level jaw ring, so the lower cheeks formed a downward cone. With the
jaw and neck-junction loops also uncreased, subdivision rounded chin, jaw and
neck into one balloon with a double-chin gradient.

**Shape:**
- **E36:** the jawline (ring 10) is a 3D curve rising toward the back,
  matched to the front sheet's outline (0.48 @ z 0.1, 0.69 @ 0.2, 0.93 @
  0.4). Ring 9 keeps the cheek side wide and nearly vertical above it.
- **Ring 11:** the neck junction now sits just under a laterally rising
  underside.
- **`head_v19._jaw_crease`:** creases ring 10 (0.85) and ring 11 (0.6).
- **E37:** the chin front is more upright (22° lean, as in the profile
  sheet).

**Paint (`face_paint`):**
- The chin height is read from the mesh (the sheet's CHIN_Y was stale).
- The neck is painted darker, with a soft shadow band under the jaw:
  rendered 235/217/204 vs the concept's 228/202/187.
- Down-tilted lower cheeks and chin get a 14% albedo lift: the chin renders
  226 instead of 182.

**Body skin.** The body is 30% darker (`skin_body` in the builder). Its
upward-facing shoulders clipped to white under the app's high sun.

Review sheet: `diagnostics/hermes-mermaid/nous-v19-jaw/jaw-review.png`.

## Chin pass (2026-10-02)

- **E38:** the chin point is lower and the jaw edge beside it higher and
  narrower. Ring 10's crease is now 1.0.
- **E39:** the neck junction (ring 11) follows the rising jawline. A level
  ring 11 showed below the jaw edge in front view and made a flat-bottomed
  chin.
- **Paint:** the neck shadow, cast band, underside and edge terms follow the
  jaw edge curve (`paint(..., jaw)`; `head_v19` passes the ring-10 loop in
  head coordinates). A band at constant height had drawn a horizontal cut
  across the V.
- **Neck length (measured, kept):** at the master camera, chin to shoulder
  line is ~0.1-0.2 of the face height (hem→chin) in the master and ~0.1 in
  the model. Only the generated front sheet has a longer neck.

Review sheet: `diagnostics/hermes-mermaid/nous-v19-chin/chin-review.png`.

## Likeness pass (2026-10-02, judged at the master camera)

- **E40:**
  - The fringe lies on the forehead (hem rows back, `HEM_RAISE` 0.14 →
    0.04, lock-plane fringe hem 1.93/1.85). In the master, the hem touches
    the upper lid and the brows barely show.
  - The side curtains (cols 7-10) hug the cheeks.
- **E41:** the dome above the bang line is scaled 0.84 vertically. Once the
  hem came down, crown→hem was 1.7× hem→chin against the master's ~1.24×.
- **Eyes and iris:** eyes ~7% larger, iris larger and dark navy (master).
- **Headset:** the band is broader (0.78) and thicker.
- **Hair:**
  - The under-layer uses the hair ink. The darker under-layer showed
    through the lock seams as jagged teeth.
  - The far-side C-curls are ~30% broader and thicker.
- **Decals:** `decal()` drops faces standing edge-on to the face. With
  larger eyes, a liner wing wrapping the temple left a face whose
  orientation was float noise, which tripped the rest-pose check.

Review sheet: `diagnostics/hermes-mermaid/nous-v19-likeness/likeness-review.png`.

## Remaining-differences pass (2026-10-02)

- **E42:** fuller cheeks. Volume went into the 3/4 diagonal (cols 1-3,
  forward and slightly out); the front width already matched the sheet.
- **Headset:** the crown point moved forward (C = (0, -0.80, 3.95)), so the
  band arches over the front of the dome as in the master. It had lain flat
  once the dome was lowered. Width is 0.58: 0.78 read as a plank.
- **Body (`build-hermes-mermaid.py`):** the master is a chunky chibi whose
  chest is about as wide as the face. The model's was ~0.55× the face.
  - Upper-body stations are widened to ~0.8×.
  - Arm paths, hands and the arm/elbow/wrist bones move outward with them.
  - Arm radii are ~1.3× and the hands are larger.
  - Bone names and the rig manifest are unchanged; HermesAquariumTests pass.

Review sheet: `diagnostics/hermes-mermaid/nous-v19-final2/final-review.png`.

## Evaluation and face-shape correction (2026-10-02)

**Honest re-measurement.** Measured at the master camera after the
"remaining differences" pass, the jaw passes had made the face-shape metrics
WORSE than at the start of the loop:

| | face IoU | features IoU | landmark RMS |
|---|---|---|---|
| start of loop | 0.738 | 0.316 | 15.5 px |
| final2 | 0.693 | 0.259 | 17.1 px |

The landmark solve had the chin 0.32 too high (the jaw passes followed the
front sheet, whose face is shorter than the master's) and the hem 0.27 too
low (E40 overshot).

**Reverted.** E43-E46 lowered the whole jaw structure to the landmark chin
and then widened it. RMS reached 13.5 px, but the face became long and
rectangular, unlike the master's round chibi face, and a grey band appeared
under the mouth. The 7-point landmark solve cannot see overall face
proportion, so landmark RMS must never be the only judge of face shape.

**Kept:**
- **E43b:** the chin point only comes down 0.12 and forward 0.05, fading to
  nothing at the jaw angle.
- **`HEM_RAISE` 0.10:** the hem sits halfway between E22 and E40.
- **Mouth:** halfway to the landmark position.
- **E47:** a softer, rounder chin (ring 10 crease 0.85, jaw edge beside the
  chin wider), as both the sheet and the master draw it.

**Final numbers:** face IoU 0.712, features 0.267, landmark RMS 15.4 px.
These are back at about the loop-start level, with the jaw, shading, body
and headset gains kept.

Review sheet: `diagnostics/hermes-mermaid/nous-v19-eval/eval-review.png`.

## Final pass (2026-10-02): face mask and pose

- **Metric fix:** the master-camera face IoU in `fit_master_camera.py` now
  cuts the model mask at the master's chin row as well. The master mask
  stops at the chin; the model's neck was counted as face and penalised
  every jaw change by ~0.04.
- **E48 (`face_diff_master.py` red/blue diff):**
  - The lower front of the face moved forward.
  - The curtain inner edge (col 6) moved back, so the near cheek shows.
  - E42's fullness was removed at eye level, where it bulged the far cheek.
- **Fair-metric comparison (master camera):**

  | | face | dome | features | total |
  |---|---|---|---|---|
  | loop start | 0.765 | 0.816 | 0.316 | 2.214 |
  | now | 0.766 | 0.902 | 0.310 | 2.288 |

  Landmark RMS is 15.1 px.
- **Rest pose (`build-hermes-mermaid.py`):** the elbows are bent and the
  hands sit in front of the body, as in the master. The arm path, hands,
  and elbow and wrist bones were moved; bone names are unchanged. The
  swim pose adds its rotations on top. At effort = 1 ("working") the arms
  lift forward with no body intersection
  (`diagnostics/hermes-mermaid/nous-v19-done/working-pose.png`).
  HermesAquariumTests pass.

Review sheet: `diagnostics/hermes-mermaid/nous-v19-done/done-review.png`.

## Hair reverted to the faceted bob (2026-10-02)

**Why the lock planes looked unnatural.** The planes are flat roof-shaped
strips laid over a curved mass. They read as stacked rectangular blocks (a
stepped band over the fringe) with jagged seams and ridges between strips.
The master's hair is one rounded bob whose large facets flow into each
other. A side-by-side at the master camera (loop start, pre-lock-planes,
lock planes) showed the faceted cage closest to the master.

**Change.** `run.sh` no longer runs `build_lock_planes.py`; `head_v19`
falls back to `facet_mass` on the sculpted cage.

**Follow-up edits:**
- Facet jitter is gentler (0.11/0.035).
- The headset sits 0.10 off the hair and keeps 0.09 clearance, so facets
  no longer poke through the band.
- **E49/E51:** the dome tapers into the hugging curtains, so there is no
  shelf ringing the head.
- **E50:** the fringe falls nearly straight. It had tucked 0.33 back and
  read as a brim.

**Master camera:** total 2.369 (face 0.767, dome 0.845, features 0.379).
That is the best features score so far, versus 2.288 with the lock planes.
`build_lock_planes.py` stays in the repo as a documented dead end.

Review sheet: `diagnostics/hermes-mermaid/nous-v19-hair/hair-review.png`.

## Hair flow pass (2026-10-02)

- **E52:** the front of the hair is one smooth arc from crown to fringe, as
  in the profile sheet. Before, the front column stepped 0.6 forward per
  ring above z 3.27 and then turned vertical: the crease between dome and
  fringe.
- **E53:** the side columns 7-12 grow monotonically in radius from ring 6
  to ring 10, the bob's bell. Before, a bulge at ring 7 sat over a waist at
  ring 8 and ringed the head as a band.
- **Curls (`build_locks.py`):** the near-side (her right) C-curls hook
  further out and up (hook offset ~0.85, tips ~1.5). A soft outward flip
  (`lo_L2`) at her left back hem matches the master's far-side flick.
- **Master camera:** total 2.364 (face 0.766, dome 0.848, features 0.375).

Review sheet: `diagnostics/hermes-mermaid/nous-v19-hair2/hair2-review.png`.

## Closing pass (2026-10-02)

**Tried and reverted (the reasons are kept in the code comments):**
- **E54, a vertical fringe:** the dark band over the fringe stayed and the
  master score fell (2.364 → 2.341). That band is lighting, not form: the
  lit, up-facing crown meets the vertical fringe face.
- **Smooth, subdivided curls:** they read as tubes or tentacles next to the
  faceted bob. The curls stay faceted, flat ribbons.

**Body remesh voxel .0027 → .0032.** The broader body had pushed the asset
to 177k tris / 8.9 MB. It is now 148k / 7.5 MB, against v18's 142k /
6.8 MB.

**Final state:**

| check | result |
|---|---|
| master camera | total 2.364 (face 0.766, dome 0.848, features 0.375) |
| landmark RMS | 15.5 px |
| face mesh | 0 folds |
| app tests | HermesAquariumTests 9/9 |
| rig | `hermes-rig.json` unchanged |

Final review (v18 → v19 vs the master, RealityKit with app lights):
`diagnostics/hermes-mermaid/nous-v19-complete-final/final-review.png`.

## Hair tone (2026-10-02)

**Cause of the dark band over the fringe.** It was the brightness range,
not the form. The front sheet's hair is a near-flat ink (~26 sRGB top to
bottom). Under the app's high sun the model's crown read ~52 and the fringe
hem ~16.

**Fix (`build-hermes-mermaid.py`).** Hair albedo ×0.3 plus a faint navy
emission (strength 3.0). Crown→hem is now ~44→27, and the facets still read.

**Rejected.** Albedo ×0.2 with emission 4.5 flattened the hair to grey.

## Face-shape pass (2026-10-02, after the user's "the face shape is still odd")

The diagnosis used a registered overlay of the Blender ortho front on the
sheet, plus the face_v2 outlines drawn over the sheet. The outer face
outline already matched within ~0.1. The odd read came from three things:

1. **Round "surprised" eyes.** The almond was h/w ~0.8 (sheet ~0.62) with
   white all round the iris. It was also ~25% too wide relative to the face
   (eye/face 0.30 vs 0.24). Now: EW 0.079, EH 0.025/0.024, iris
   0.024×0.028, EYE_X 0.098.
2. **Forehead "horns".**
   - The fringe's V-splits were wide and deep. The hem is now blunt
     (`refine_fringe.HEM` capped at 1.90); the sheet's splits are hairline.
   - **E56b:** the skull's temples sat only 0.04 inside the hair beside
     the fringe corners, and the facet jitter let skin poke through. The
     temples moved in 0.10-0.16.
3. **Smaller fixes:**
   - Mouth up 0.009 head units (it sat ~0.12 model units below the sheet's).
   - **E55:** face sides narrowed 3-5% at z 0.7-1.8.

E56 (pulling the curtain over the temples) was tried first and reverted: it
did not address the cause.

**Master camera:** 2.129 (face 0.767, features 0.272). Features drop
because the master's fringe has splits the blunt hem no longer draws; the
front sheet is matched instead.

Review sheet: `diagnostics/hermes-mermaid/nous-v19-faceshape/faceshape-review.png`.

## Naturalness pass (2026-10-02)

Ortho silhouette widths per height against the front and profile sheets:

- **Earmuffs.** The flip locks were wide blades (1.3-1.4) rooted at z 2.1
  and reached past the frame on her right. They read as earmuffs/wings, and
  her left was 0.5 narrower than the sheet. `build_locks.py` now has six
  narrow (≤0.8) locks on both sides. Each runs down the bob and hooks out
  only at jaw level (z ~0.6-1.0, as on the sheet) or at the hem.
- **E57:** the back of the bob was 0.4-0.8 deeper than the profile sheet;
  about half of that was pulled in.
- **Fringe on the brows:** `HEM_RAISE` is 0 (sheet hem z 1.86) and the
  brows sit just under it (BROW_Y 0.008). The 0.10 raise had left a strip
  of forehead.
- **Eyes:** EW 0.086 (eye ~0.29 of the face width) with the almond kept at
  h/w ~0.62. The previous pass had made the eyes too small.
- **Neck:** the head joint is .196 (was .188), for a short visible neck.

**Result:** 146k tris, 0 face folds, HermesAquariumTests 9/9, master
camera 2.121.

Review sheet: `diagnostics/hermes-mermaid/nous-v19-natural/natural-review.png`.

## Silhouette pass (2026-10-02, "until nothing differs")

Driven by row-by-row ortho silhouette widths against the front and profile
sheets (table in `diagnostics/hermes-mermaid/nous-v19-silhouette/silhouette-widths.txt`).

**Edits:**
- **E58:** the back moved in 0.45 (it was still deeper than the profile
  sheet at every height), and the crown-front came forward 0.3. The sheet
  is asymmetric: her right curtain hugs the face at z 2.0-1.4.
- **E59/E60:** second steps on the same three gaps, plus her right lower
  hair tucking in at the hem.
- **E61:** the profile fringe tips hang to z ~1.75.
- **E62:** 60% of E51 undone. E51 had left a waist at z 2.0-2.2, which
  rendered as a brim.
- **E63:** the fringe hangs nearly straight from the dome, as in the
  profile sheet.
- **Flips:** her right flips hook at z ~1.0-1.2 and reach less far out.

**Silhouette result.** Front and profile are within ±0.2 model units at
every height from z 2.6 to 0. There are two exceptions:
- the profile fringe tip at z 1.8 (-0.40);
- rows below the chin, where the sheets have no body.

**Facets.** Vertical ring jitter is cut and the per-column ridge raised, so
the faceting runs as strand planes from the crown, not horizontal bands.

**Headset.** It now sits forward as the brief and the master say: the
clasp is at the side-front above the fringe corner (B (1.85, -0.55, 2.8)),
and the band is 0.46 wide. The front and profile sheets disagree on the
clasp position, so the master decides.

**Rejected.**
- Smooth-shading the dome-to-fringe band read as a glossy plastic helmet.
- A brighter second material on the fringe front read as a separate blue
  band.

**Follow-up.** The fringe centre is 0.06 lower (`refine_fringe.HEM`), so the
profile fringe tip now matches within 0.08. Her right upper flip hooks at
z ~1.0. The sheet's flip tip is a thin hook, so single rows at z 1.2-1.4
still trade ±0.3-0.7 against each other.

**What remains (not silhouette).**
- Under the app's high sun, the up-facing dome and the front-facing fringe
  still meet in a visible light/dark edge. This is lighting and style; the
  concepts are illustrations with painted light.
- (Resolved later on 2026-10-02.) Both references draw the fringe as locks
  with narrow wedge splits. `refine_fringe.SPLITS` raises one hem vertex
  per split, on a denser hem (CUTS 7, ~0.045 spacing). That gives five
  slim splits, not the wide V that read as horns.

Review sheet: `diagnostics/hermes-mermaid/nous-v19-silhouette/silhouette-review.png`.

## Shadow pass (2026-10-02, "face side and jaw shadows look unnatural")

The concept's face is flat-lit ivory. Its only shadow is a soft neck tone
under the chin. The model stacked three shadows:
- RealityKit's high-sun shading of the cheek sides and the jaw underside;
- painted jaw-underside and side-plane shades;
- a hard creased jaw edge.

**Changes:**
- Skin gets a small self-light (emission .22 of the ivory).
- The painted underside and side-plane shades are removed; the neck tone
  and the cast band are lighter.
- The jaw crease is softened (ring 10: 0.45, ring 11: 0.3).

**Result:** skin median 247/239/230 (master 246/235/226). The lower face
reads flat-lit, with only a light neck tone.

Review: `diagnostics/hermes-mermaid/nous-v19-shadows/shadow-review.png`
(columns: reference | before | after).

## Profile pass (2026-10-02, "side view: shadows and face shape don't match")

**Measurements** against the profile sheet (lit-face vs neck boundary per y,
face extents per z):

| | sheet | model |
|---|---|---|
| hair (start of cheek cover) | y -0.45 | y -0.2 (lower face read heavy and wide) |
| neck front | y -0.28 | 0.15 further forward |
| neck width | front sheet ~1.07 | 0.87 |
| chin | — | 0.13 forward, 0.12 low |
| groove under the lower lip | present | missing |

**Edits:**
- **E65:** the curtain inner edge comes 0.2 forward at cheek level, and the
  chin moves back 0.07 and up 0.06 (between the master and the sheet).
- **`head_v19._neck`:** the neck is now an ellipse (half-width 0.53, depth
  0.38, centred at y 0.10).
- **`face_paint.nose_form`:** a deeper lower-lip groove plus a chin pad.
- **`face_v2.upper_liner`:** a shorter wing. Projected onto the side of the
  face, it had smeared back along the cheek in profile.
- **Skin emission 0.60.** The master-camera skin luminance spread now
  matches the master (p50-p5 46.3 vs 46.7).

**Remaining.** In profile the eye is still a front-projected drawing, not a
side-view eye.

E66 was tried and reverted: flattening the eye-level face front so the eye
sits on a front-facing plane barely changed the profile read. A side-view
eye needs real eye geometry (a recessed eyeball with iris/pupil, and lids
as geometry). `face_paint.eye_planes` (local flat sockets yawed 35 deg) was also tried and is
not used: the socket stood proud of the cheek and made the profile eye larger.
The geometry route changes how the `hermes_eye_*` / `hermes_pupil_*` /
`hermes_lid_*` nodes are built, though not their names.

Review: `diagnostics/hermes-mermaid/nous-v19-profile/profile-review.png`.

Known gaps (honest, as of the final sheet):

- (Addressed by the topology pass:) the thick visor fringe and the grid facets.
- The face is smooth, while the front sheet shows faint low-poly planes.
  This is kept on purpose: the master's face reads smooth.
- The right-side crescents are smaller and less legible than the master's
  sweeping curls.
- The master's eyes are larger relative to the face, and its face has a
  softer heart shape. The model's face reads rounder and more doll-like.
- These gaps are about topology and lock design, and more vertex edits
  won't close them. The next step is hand-laid low-poly topology for the
  hair (large planes along the lock flow) and a lock-by-lock redesign of
  the curls.

Earlier gaps:

- The fringe splits stop at z ≈ 2.09, below ring 6; the reference reaches
  about 2.3.
- The side flicks read as scales in profile, and the master's flicks are
  bigger and lower than the model's.
- Skin reads cooler and flatter than the master's warm ivory. The v18 skin
  material, with its glow, is kept.
- The face reads rounder than the master's heart shape.
- The nose is a decal only.
- The back and top are not verified, because there is no back reference.
- The reference front/profile disagree on headset placement; this is unresolved.

## 3D eyes and face planes (2026-10-02)

**Why.** In profile the eye was still a front-projected drawing. The
measurements below also showed that the face around it was off.

**Measurement.** RealityKit renders under the app's lights, with
near-orthographic `profile` / `frontfar` cameras (40 m, 1.25 deg) added to
`native_preview.swift`. Contours are registered on the sheets by hem-to-chin:

- **Profile.** The nose was in place, but the face around it sat too far
  forward: the bridge root under the eye by ~10 sheet px, the lips by 12-20
  and the chin by 15-20. The side view read as one convex curve. Between
  the outer eye corner and the hair, ~40-50 px of bare cheek showed; the
  sheet has the curtain right behind the eye wing.
- **Front.** Skin width per row matched the sheet within 1-3% down to the
  nose, then ran 7-16% wide from the mouth to the jaw. This is the round,
  chubby lower face.
- **Master.** The far eye was ~37% of the near eye's width; the concept's
  is ~63%. The face under the eyes turned 15 deg at the inner corner, 35
  at the centre and 68-77 at the outer corner, so the eyes faced sideways.

**Changes:**

- **`eyes3d.py` (new):** real eyes.
  - An almond opening is cut in `face` / `face_backing`, with its rim
    snapped to the drawn outline.
  - Sclera, iris, glow, pupil and glints are patches on an eyeball surface
    (R 0.065), clamped 0.8 mm inside the face. A full sphere bulged out at
    the outer corners, where the face turns faster than any sphere.
  - Eyeball patches go under `hermes_eye_*`, iris parts under
    `hermes_pupil_*`, and a skin socket sits behind.
  - The faces cut from the opening become `lid_skin_*` under
    `hermes_lid_*`. They keep the face material and UVs, so the closed
    lid shows the painted skin. A separate skin decal read as a patch.
  - Face and lid share the normals of the uncut mesh as custom normals.
    The rim snap leaves slivers whose own normals streaked the lid.
  - Liner, lashes, crease, brows and the closed-lid line stay decals.
  - Node names and `hermes-rig.json` are unchanged.
- **`face_paint.nose_form`:**
  - The nose tip goes from 0.033 to 0.040, with x width 0.0105.
  - New `RECESS`: a lower-face set-back that reaches 0.011 at the chin.
  - The displacement is relaxed 10 times instead of 7.
- **E67:** the curtain front edge (hair cols 6-7) comes forward from eye
  level to the jaw. Below the chin it goes slightly back, so the neck
  shows in profile.
- **E68:** lower-face taper, scaling head rings 7-11 in x
  (0.97 / 0.93 / 0.87 / 0.87 / 0.92). Front widths now match the sheet
  within 2% on every row from the hem to the chin.
- **E69:** a flat anime face front at eye level (cols 1-3 forward, x
  unchanged). The eye-centre normal now turns 20 deg instead of 35, and
  the far eye in the master view is ~55% of the near eye's width.

**Results.** In profile, the nose now projects, the mouth and chin sit
back, a narrow face strip shows with a diagonal jaw, and the eye is
narrower. In front, the chin has the sheet's soft V. On the master, the
hair starts right after the near eye's wing.

**Checked.** HermesAquariumTests pass (9/9), and `hermes-rig.json` is
unchanged. The blink is seamless.

**Not regressions.** A few isolated black pixels (one on the nose bridge,
some on the body) are present in the committed model at the same pixels.

**Kept on purpose:**
- The crown sits lower than the sheets: earlier user feedback said the head
  read too big.
- The model's face is a little longer than the sheet's. Normalising by
  hem-to-chin therefore makes the hair look deeper than it is; the
  registered blockout overlay (`run.sh`) shows the back and hem matching.

Review: `diagnostics/hermes-mermaid/nous-v19-eyes3d/review.png`.

## Skin, eyes and nose pass (2026-10-02, "face shadows, eye spacing and the nose bridge still differ")

- **Shadows were being washed out.** The skin's flat emission colour was
  added on top of the painted face texture. The front face clipped at 255
  where the sheet sits at 251/236/226, so the fringe-hem band, nose marks
  and neck shade never showed.
  - The face now splits into two baked textures:
    - `face_shade.png`: the painting x `FACE_ALBEDO` 0.80, so the 5000 lx
      sun can't clip it;
    - `face_glow.png`: the painting x `FACE_GLOW` 1.0 x `GLOW_TINT`
      (1, .90, .83). It is peach because RealityKit's shade side goes grey.
  - USD drops Emission Strength for a textured emissive, so the strength
    is baked into the glow texture.
  - Measured on the front skin: p50 248/235/222 vs the sheet's
    251/236/226, and p10 224/208/191 vs 228/202/187. Before: p50
    255/250/242 and p10 209/199/190, clipped.
  - The rest of the skin (body, arms, sockets) gets the same split from the
    same constants, so the neck and shoulders no longer glow flat white
    beside the face.
- **Eye spacing.** The irises sat 0.010 toward the nose (12% of the eye
  width) and read as cross-eyed once the eyes were 3D. The sheet's sit 2-5%
  inward, so `IRIS_DX` is now 0.003; gaze comes from the pupil joint.
  - The iris is now 0.65 of the eye width (`IRIS_R` .028/.032).
  - The glint radius is now .0047.
- **Nose.** It is now painted after the blur, crisply, as the front sheet
  draws it:
  - a narrow bright streak on the lower bridge;
  - a rounded peach-tan tip;
  - two curved nostril strokes;
  - a soft one-sided shade on the far (-x) side of the bridge. It is faint
    from the front and becomes the master's bridge contour at 3/4.

  The nostril tuck is halved (-0.0025): its crease read as a dark line.
  A paint lift of the nose underside was tried and reverted: it read as a
  white patch.
- **Not matched, on purpose.** In the master the nose tip sits right under
  the far eye's inner corner (11% of the way between the eyes). At the
  fitted 32 deg, no nose depth allowed by the profile sheet gets past 33%,
  and even 45 deg gives 24%. That is an illustration cheat.
- **Known RealityKit artifact.** A few single black pixels lie along
  curves on the nose side and the body. They are NaN shading: pure
  0/0/0 against a 9/14/17 background. They are unaffected by IOR, UV
  layout, the backing or the bookkeeping attributes, and vanish only with
  flat shading. They are present in every earlier build, and sub-pixel at
  aquarium scale.

Review: `diagnostics/hermes-mermaid/nous-v19-skin/review.png`.

## Flat-lit skin (2026-10-02, "remove the shadows boldly")

**Why.** The user still found the shading awkward. The remaining shadows
were mostly lighting on geometry, not paint:

- a grey band across the near cheek, where E69's flat front turns into the
  side plane;
- the jaw underside;
- ripples around the mouth;
- the nose underside.

The concept is lit almost flat.

**Blocker.** A glow texture can't exceed 1.0, which renders at only ~200
here, so lowering the albedo made the face dark (p50 ~225).

**Fix.** RealityKit honours the `scale` input of `UsdUVTexture`.
`build-hermes-mermaid.scale_face_glow()` now patches the exported USDZ
(both the review copy and the installed one) to put `FACE_GLOW` there:

- `FACE_ALBEDO` 0.35: little of the colour depends on the sun;
- `FACE_GLOW` 2.0 x `GLOW_TINT` (1, .94, .91): the glow carries the colour.

The body skin uses the same constants.

**Result.** Front skin p50 is 249/235/223 vs the sheet's 251/236/226. The
shade side is 245/229/218, previously 224/208/191. The painted marks stay:
the crisp nose, the soft jaw/neck tone and the lips. HermesAquariumTests
pass.

**Trade-off.** The 3D form now reads mainly through the silhouette and the
painted marks, as in the concept, not through lighting.

Review: `diagnostics/hermes-mermaid/nous-v19-flat/review.png`.

## Flat-shaded skin removes the black pixels (2026-10-02)

**Symptom.** Single NaN-black pixels appeared along curves on the nose side
and the shoulders, and on the headset band. They were pure 0/0/0 against a
9/14/17 background, present in every build including e861384.

**Ruled out.** They did not move with any of these:

- IOR, roughness or specular (patched straight into the USD);
- the UV depth term;
- the face backing;
- the bookkeeping attributes.

**Cause.** They vanish when the mesh has no interpolated normals.

**Fix.** The face, face backing, lid patches, eye sockets, body skin and
headset band are now flat-shaded. With the flat-lit skin the sun barely
reaches the colour, so no facets show on the skin. The band shows faint
facet planes, in keeping with the low-poly headband.

**After.** An isolated-dark-pixel scan of the face, 3/4, master, profile,
nose-zoom and blink renders flags only lash, liner and lip-line pixels.

**Asset.** 155.7k tris in 62 meshes, 7.70 MB; e861384 had 145.7k tris in
58 meshes, 7.32 MB. The increase is the 3D eyes. HermesAquariumTests pass.
An on-device frame-time measurement still needs hardware.

Review renders: `diagnostics/hermes-mermaid/nous-v19-flatshade/`.

## After the gate

The order is: hair lock design (fringe splits and flick locks) → deliberate
low-poly topology, laid out along the cheek/jaw and lock flow rather than
produced by Decimate/Remesh → headset → face texture from approved art →
materials → then body and rig.
