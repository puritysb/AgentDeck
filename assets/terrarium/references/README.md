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
