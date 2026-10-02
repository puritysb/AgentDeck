# Hermes mermaid turnaround brief (for image generation)

> 2026-10-01 revision: the head-first study in [head-study/REVIEW.md](turnaround/head-study/REVIEW.md) supersedes the front-first generation order, fixed 45% ratio and equal projected-width acceptance rules below. The original large three-quarter concept remains the master; generated views are proposals, not calibrated geometry. Full-body and expression outputs below are deferred until the head gate.

Goal: lock the character design as a consistent set of 2D views **before** any
3D work. The 3D model will be fitted to these images by measurement:
silhouettes per view, then texture projection of the face. Consistency and
scale therefore matter more than beauty in any single image.

## Inputs

1. **Design target:** the large head in `hermes-mermaid-nous-face.png` (left
   half), which the user chose on 2026-10-01. Match its head, face, hair and
   headset as closely as possible.
2. **Identity check:** the official mark `design/brand/hermes.svg` (Nous girl).
3. **Body reference:** `hermes-mermaid-turnaround.png`, for the small mermaid
   body and tail only. Its head is **not** the target.

## Design decisions already made by the user (do not regress)

- The white arc is a **headset**, not a hairband. The band sits forward on the
  crown, just behind the bangs. Its end has a round white clasp with a black
  dot and a small hook (as in the target image). The earcups are hidden under
  the hair.
- The white strokes on the mark's hair are **light**, not drawn lines. Do not
  paint white streaks on the hair; highlights come only from facet shading.
- Keep visible, fine, softly arched **brows**, just under the fringe.
- The **iris sits high**, its top partly under a heavy upper lid, with a bold
  winged liner. The lower lash line is fine.
- **Face:** soft round cheeks narrowing to a small, soft chin; a natural jaw
  with no angular break. The nose is a small shadow. The lips are small, full
  and grey.
- **Hair:** a big, rounded, near-black bob in **soft low-poly** (large flat
  facets). It has blunt bangs with a few pointed splits and a **natural wave**.
  The ends flick outward and up in broad pointed locks, never horns or boxy
  flaps.
- **Body:** a small pale torso with naturally connected shoulders, elbows,
  wrists and small simplified hands (thumb plus one finger group). The teal
  tail is smooth or very gently faceted, **not** broken into pieces. There
  are two broad pale-teal fin lobes.
- Head plus hair is about 45% of the total figure height. Keep this **identical
  in every view**.

## Canvas rules (identical for every image)

- 1024 × 1536 PNG, portrait.
- A solid flat background `#16303a`: no gradient, bubbles, shadow, vignette,
  text, labels or watermark.
- Even, soft, frontal-top lighting, the same in every image.
- **Orthographic-looking** (no perspective distortion), camera at chest height.
- **Fixed scale and placement:** the top of the hair at y = 96 px, the fin tips
  at y ≈ 1440 px, and the figure centred horizontally. The head/body ratio and
  pixel size must match across all full-body views.
- A neutral pose: arms relaxed and slightly away from the body so the arm and
  torso silhouettes are separable. The tail hangs straight down in the front
  and back views and sweeps back in the profile views.
- A neutral, calm expression with the eyes looking straight ahead (except the
  expression set).

## Views to generate

Generate `full/front.png` first. Then use it as an input image for every other
view, so the character stays the same.

| File | Content |
|---|---|
| `turnaround/full/front.png` | Full body, 0° (facing the viewer) |
| `turnaround/full/three-quarter.png` | Full body turned 45°, face toward the viewer's left (same direction as the mark) |
| `turnaround/full/profile.png` | Full body, 90° profile facing the viewer's left |
| `turnaround/full/three-quarter-back.png` | Full body, 135° (back three-quarter) |
| `turnaround/full/back.png` | Full body, 180° |
| `turnaround/head/front.png` | Head close-up, 0°. Same canvas; the head fills about 80% of the width, with the chin at y ≈ 1100 px |
| `turnaround/head/three-quarter.png` | Head close-up, 45°, same scale as the head front |
| `turnaround/head/profile.png` | Head close-up, 90°, same scale |
| `turnaround/expr/blink.png` | Head front: both eyes closed, as a gentle downward-curved lash line |
| `turnaround/expr/smile.png` | Head front: a soft closed smile |
| `turnaround/expr/surprised.png` | Head front: eyes slightly wider, a small open mouth |
| `turnaround/expr/concern.png` | Head front: a slight frown, the mouth a little down |

Save everything under `assets/terrarium/references/turnaround/`.

## Base prompt (prepend to every view)

> Character turnaround sheet image for a 3D modeller. Cute stylized Nous girl
> mermaid, matching the attached target head exactly. Big rounded near-black
> soft-low-poly bob with large flat facets, blunt bangs with a few pointed
> splits, natural gentle wave, and ends flicking outward and up in broad
> pointed locks. A white headset band forward on the crown just behind the
> bangs, with a round white clasp, a black dot and a small hook; earcups hidden
> under the hair. Pale ivory skin, soft round cheeks narrowing to a small soft
> chin. Fine arched brows under the fringe. Large dark almond eyes with the iris
> high under a heavy upper lid, bold winged liner and fine lower lashes. A small
> nose shadow; small full grey lips. Small pale torso with naturally connected
> shoulders and small simplified hands. Smooth teal mermaid tail with two broad
> pale-teal fin lobes. No white streaks painted on the hair. Solid flat
> background #16303a, even soft lighting, orthographic, no text, no bubbles.

Then append the view line, e.g. *"Full body, exact front view (0°), neutral pose,
arms relaxed slightly away from the body, tail hanging straight down. Top of
hair at 96 px, fin tips near 1440 px."*

## Acceptance check before handing back

Place all full-body views side by side and reject and regenerate any view where:

- the head/body ratio, the head width or the hair volume differs visibly;
- the headset position or clasp differs, or the hair shows painted white
  streaks;
- the face (eye size and height, jaw, lips) differs from the front view;
- the scale or position breaks the canvas rules.

Record the prompts actually used, and any rejected attempts, at the end of this
file.
