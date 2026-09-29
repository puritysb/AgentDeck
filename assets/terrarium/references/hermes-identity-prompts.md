# Hermes identity correction prompts

## Arm correction, v4

`hermes-mermaid-arms-v4.png` edits only the concept's arms/shoulder junctions,
using v3 as the edit target with the built-in image generation tool. Visual
inspection finds clearer shoulder/elbow/wrist connections and asymmetric
resting poses while retaining the head's appearance. The fingers are more
detailed than needed at dashboard scale; simplify them to a palm/finger group
and thumb during modeling. This is still concept art, not a runtime mesh.

### Exact arm-edit prompt

Use case: precise-object-edit.
Edit the attached Nous girl mermaid concept. Change ONLY the arms and their shoulder-to-torso junctions in BOTH the full-body view and enlarged view. Keep the head, white head accessory, hair, eyes, face shape, lips, expression, head pose, body/tail silhouette, colors, lighting, background and layout unchanged. Do not redraw or beautify the head.
Replace the two boneless white paddle-shaped appendages with short, naturally connected stylized human arms. Show a subtle rounded shoulder on each outer side of the upper torso BELOW the neck, a gently tapered upper arm, a readable softly bent elbow, a slimmer wrist, and a small simplified hand with a visible thumb and a unified finger group. No mechanical joint balls or anatomical muscle detail. The hands should be small and graceful, not oversized mittens and not flippers.
Give the arms a relaxed underwater pose with mild asymmetry: the near arm bends gently inward with the small hand beside the lower chest; the far arm is slightly lower and trails outward with its hand angled softly downward. Both shoulders remain relaxed, not shrugging. Keep arms compact and cute, but long enough for elbow and wrist to read. Maintain smooth pale skin and the modest teal bodice. Ensure no neck-mounted arms, detached hands, extra fingers, shoulder gaps, or arms embedded in hair. Match the same anatomy and pose in the enlarged depiction. Everything above the shoulders must remain exactly as supplied.

Generated with the built-in image generation tool on 2026-09-30. The final
accessory correction is saved as `hermes-mermaid-identity-v3.png`. This is an
authoring reference, not the runtime model or an approved design. Preserve the
official Nous girl accessory, bob, face shape and composed expression; only
the body is adapted into a mermaid. The initial output still made a forked bow
and was rejected in evaluation. The second pass removes that fork, but exact
source contour/placement still needs comparison before mesh implementation.

## Initial correction

Use case: identity-preserve.
Asset type: corrected character art reference for AgentDeck's Nous girl mermaid 3D model. This is concept art, not a screenshot.
Input image 1 is the official Nous girl portrait and is the STRICT source of truth for all head features.
Input image 2 is the previous mermaid concept to correct. Retain only its small teal mermaid body, palette, and underwater character idea; its inconsistent head accessory and face are errors.
Create ONE beautifully drawn character in the same left-facing three-quarter direction and same calm gaze as the official portrait, full body, occupying most of a landscape image. To the right provide a large close-up of the EXACT SAME head from the SAME angle, for checking fidelity. Do not invent other views or expressions.
Preserve the original head as closely as possible: the original white curved head accessory, its narrow width, precise position on the crown, and its small hooked curled terminal adjacent to the temple exactly as in image 1. It must sit flush against the hair. Do not turn the terminal into a cut-out bow, headphone ear cup, microphone, floating ribbon, emblem, or a giant broad band. Preserve the original black bob outline, outward sweeping curl, blunt irregular fringe, side lock length, and broad smooth black rear hair mass. Preserve the original almond-shaped eyes, fine dark lashes, brow spacing, nose/chin profile, natural jaw, subtle parted lips and composed expression. Do NOT replace her face with a generic chibi doll, huge circular eyes, infant rounded cheeks, a tiny button mouth, a helmet, or an unrelated anime girl. Prioritize resemblance over adding cuteness.
Only below the neck adapt the body into the previous concept's small modest teal mermaid: tiny arms, compact curved torso, naturally backward-curving tail and two broad pointed pale-teal fin lobes. Head remains recognizable Nous girl. Subtle faceted body compatible with simple aquarium characters, refined clean illustrative head, not plastic rendering.
Plain muted dark teal background, soft even light, no scenery, no other characters, no labels or text, no watermark. Both head depictions must agree exactly in head accessory placement, face proportions and hair.

## Targeted accessory correction

Use case: precise-object-edit. Image 1 is the EXACT official reference. Image 2 is the edit target. Change ONLY the white head accessory in BOTH depictions of the head in image 2. Keep every other element, face, hairstyle, expression, pose, mermaid body, framing and background unchanged.
Critical correction: the white accessory in image 2 wrongly ends in TWO symmetric forked ribbon tails around a big black keyhole. Delete that entire bow/keyhole ending. The original reference has a narrow white band and ONE tiny asymmetric curved hook near the temple. Trace the actual contour from image 1: a slim curved white strip lies flush along the crown, narrows near the temple, makes one small irregular loop/curled hook only at its very tip; the little tip curves inward like a tiny comma. NO symmetric tails, NO bow, NO omega symbol, NO keyhole, NO badge, NO earpad. Make the white band roughly 30% narrower than in image 2 and place its end at the same proportional location as image 1. This is an exact identity-preserving accessory correction, not a redesign. Ensure the two shown heads have the same corrected accessory. Do not change the girl's face or body.
