# 2026-10-01 — Hermes face sheet, rebuilt app mesh and a turnaround-fit tool

### Problem

Every 3D Hermes candidate read as uncanny or "not her", and more than a dozen
iterations kept moving the target. The face was tuned as numbers inside the
Blender builder with no approved design to match. The body was built from
separate tubes and balls that met in visible steps. Each fix to head size, hair
or jaw was judged by eye against a concept that no view actually pinned down.

### Solution

- The face is designed as a flat 2D sheet first (`assets/terrarium/hermes_face.py`)
  and approved, then laid onto a head fitted to its outline, unchanged.
  Features are read off the official mark: heavy lid over a high iris, spiky
  outer lashes, a hooked nostril stroke and an M-shaped upper lip. Fine brows
  and a long, nearly straight jaw were added at the user's request.
- The app mesh (`build-hermes-mermaid.py`, schema-2 contract unchanged) now has:
  - A white **headset**, not a hairband: a band into the hair, a clasp, earcups
    hidden.
  - Hair highlights from lighting, not painted decals.
  - Bangs formed by the hair shell itself.
  - One voxel-fused torso/arm/hand surface. An arm owns a vertex only when its
    source surface is nearer than the torso's.
  - Low-poly hair with flicked ends.
- The user then chose to lock the design as a 2D turnaround before any further
  3D work. `references/hermes-turnaround-brief.md` is the image-generation brief
  (views, canvas rules, decisions not to regress). `fit-hermes-views.py`
  measures a model against those views by silhouette IoU per class, plus hair
  height and width.

### Key design decisions

- Rejected along the way and recorded in `docs/hermes-agent.md`:
  - An unlit "ink print" rendering: it read as a sticker.
  - Diamond-faceted body: it read as pieces.
  - A separate fringe sheet: seams and a visor.
  - Sharp flick teeth: horns.
- 3D proportions are now fitted to approved views by measurement, not by eye.
  The v18 mesh against the older turnaround: hair IoU 0.54 (front), hair height
  0.47 against 0.54.
- Image generation is outside Claude's tools; Codex generates the turnaround
  from the brief.
