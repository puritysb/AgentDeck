# Hermes head study — 2026-10-01

> The two candidate PNGs are not committed. They are assets of the
> [`assets-hermes-character-candidate`](https://github.com/puritysb/AgentDeck/releases/tag/assets-hermes-character-candidate)
> prerelease (with `SHA256SUMS`), named `head-study-candidate-01.png` and
> `head-study-candidate-02.png`. `assets/terrarium/hermes-head/ref/` holds the
> crops of candidate-02 that the blockout is fitted to.

Status: design candidates, not approved geometry or production textures. Built-in image_gen used.

## Authority

The large left three-quarter head in ../../hermes-mermaid-nous-face.png remains the master. Neither generated front nor generated profile replaces it. The original brand mark is an identity check; the old turnaround head is excluded.

## Review

- candidate-01.png: retains the master cheek-to-chin curve and broad swept locks substantially better than the existing v18 mesh. Rejected as a fitting blueprint: profile is too frontal and brows are mostly obscured.
- candidate-02.png: preferred review candidate. Profile is more lateral and brows are visible. Remaining discrepancies: eyebrows are heavier than requested; the side headset clasp moves upward relative to the eye/crown compared with the three-quarter view; the front lips appear a little wider; visible hair width varies plausibly with rotation but geometric consistency is NOT proved. Background is not perfectly flat. Do not feed these images into colour segmentation without manually reviewed masks.
- The source three-quarter is mildly tilted. It must not be labeled an exact 45-degree calibrated camera.

## Fitting contract

Use separate reviewed masks for hair, exposed face, headset, torso, tail and fins. Face ink belongs to face, not hair. Render model object/material ID passes; verify colour-space round trips before comparing. Keep raw image placement as well as similarity-aligned results; align on facial landmarks, never on a tail-expanded bounding box. Record eyes' inner/outer corners, brow endpoints, nose tip/base, lip center/corners, chin, crown and headset clasp. Report landmark error normalized by face width alongside mask IoU and contour error. Current fit-hermes-views.py remains an exploratory legacy tool; no new scores are asserted.

## Next gate

Resolve brow weight and headset placement in the head study, then block out ONLY the head using the master three-quarter plus proposed front/profile. Fit cheek/chin, forehead, bangs boundary, side locks and rear volume before materials or expressions. Show overlays at calibrated cameras. Body height ratio is deferred; 45% is not an approved measured target and the old reference's 54% is not this head's requirement. Keep one rest pose across body views and rotate only the camera. Full-body and expression generation follows the head gate. Runtime assets have not been replaced by this study.

## Actual prompts

### Candidate 01

Create a single wide landscape three-view HEAD ONLY model-design study, three equally sized panels on one flat dark blue-green background. Use the attached image strictly as identity reference: ONLY the large left-hand character head is the master design, not the small characters on the right. Left panel: reproduce that master three-quarter head facing viewer left faithfully. Middle: the SAME head in exact front orthographic view. Right: the SAME head in exact left-facing profile. Heads at identical scale with crown, eyes, nose, mouth, chin aligned horizontally; short neck only, no torso, no tail, no lettering or extra objects. Preserve the master's gentle face, soft cheek taper into small chin, high dark iris occluded by heavy upper lid, delicate visible eyebrows under bangs, subtle small nose and small full grey lips. Avoid huge round doll eyes or surprised expression. Preserve near-black softly faceted bob with broad flowing layered locks sweeping out and up, cheek-framing locks and continuous bangs with only narrow strand separations, not detached panels. White HEADSET arc forward on crown, small round white connector with black dot and short hook at side, earcups hidden under hair. No bows. Hair highlights must be real subdued facet lighting, NEVER painted white stripes. Match the large reference head's silhouette and expression above all. Soft consistent studio lighting, low specularity, no plastic shine. This is a proposed multi-view design, not a redesign.

### Candidate 02

Edit the attached three-head sheet with ONLY two corrections. Preserve the left three-quarter head's identity, facial proportions, lips, cheek/chin and all hair volumes. (1) Make delicate softly arched eyebrows clearly visible in the small gap between bangs and upper eyelids in all views; do not confuse eyelid crease with eyebrow, do not raise the fringe significantly. (2) Rotate ONLY the rightmost head to a strict 90-degree left-facing orthographic profile: one near eye seen from the side, far eye fully occluded, clear modest nose/philtrum/lip/chin side silhouette, never a protruding long nose. Keep same head scale and eye/chin/crown heights. Middle head stays exact front. Same soft low-poly near-black hair, subdued physically shaded highlights, same headset and flat blue-green background. No text, labels, painted white hair stripes or new accessories. Do not make face cuter/rounder or enlarge eyes.

