# Hermes mermaid modeling reference

`hermes-mermaid-turnaround.png` is an AI-generated modeling reference, not a
production mesh or an official Hermes mascot. Created with the built-in image
generation tool from the user's preferred cute Nous girl mermaid concept and
NousResearch's `apps/desktop/public/nous-girl.png` portrait.

Prompt: front, side and rear orthographic views of the preferred compact mermaid;
retain the black blunt bob, single outward curl, pale face, large dark eyes,
tiny torso and arms, chunky dark-teal tail and broad two-lobed fin. Use clean
large facets, no separate hair spheres or added jewelry. Neutral dark backdrop.

The actual runtime model is authored by `../build-hermes-mermaid.py` and saved
in `../hermes-mermaid.blend`. Runtime motion is controlled by Apple's
`HermesSwim`; `preview-hermes-motion.swift` and `render-hermes-preview.py` replay
its numerical pose samples for visual review. The reference establishes visual
intent; it is not a screenshot of the implemented model.

## Redesign after app review

`hermes-mermaid-redesign.png` is the new **concept only**, generated with the
built-in imagegen tool after the user rejected the runtime mesh seen in the
iPad app. It is not the current USDZ or an app screenshot. The previous
turnaround and production model have not passed visual acceptance.

Prompt: rebuild a compact, buoyant Nous girl mermaid from the upstream portrait;
short wide cheeks, flat illustrated eyes instead of protruding spheres, dark
blunt bob and outward curl, the upstream pale headband cue, small mitten hands,
short plump teal body and broad two-lobed fin. Use matte low-poly cel shading.
Show a swimming three-quarter view, front/side views and small-size comparison
with the existing Claude/Codex creatures; mark the sheet CONCEPT. Avoid a long
face, hair helmet, long neck, narrow fin, jewelry, scales and rigid doll pose.

The inputs were the upstream `nous-girl.png` and an actual local iPad Simulator
capture (for peer style and scale only; its rejected mermaid was explicitly
excluded from the desired design). Next modeling work must compare the actual
mesh against this sheet at front, side and dashboard size before acceptance.

`hermes-mermaid-nous-face.png` is the subsequent **concept-only** revision after
the user's explicit preference for the original Nous girl face. Built-in
imagegen edited the redesign using the upstream portrait as the identity
reference. Prompt: preserve the mermaid body and comparison layout; replace
generic round baby eyes, broad smile and blush with the original's elongated
almond eyes, eyeliner, composed sideways gaze, delicate closed mouth, tapered
lower face, uneven fringe and precise hooked headband. Keep tiny expressions
restrained. This is the latest facial direction, not an accepted runtime mesh.
