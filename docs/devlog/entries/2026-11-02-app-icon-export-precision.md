# 2026-11-02 — App icon export precision across Mac and Linux

The 1254px icon master exposed a portability boundary in native image resizing.
With Sharp 0.34.5, ARM macOS/Node 26 reproduced all 19 committed exports exactly;
Ubuntu/Node 22 differed in the three transparent 640px exports. The other sizes
and opaque Apple exports passed. Disabling SIMD did not resolve it.

The diagnostic comparison measured a maximum raw RGB difference of 128, alpha
difference of 2, and visible difference of 3.196/255 over black or white. Hidden
RGB alone therefore did not explain the failure. A one-level visible-rounding
allowance also failed. We rejected increasing the tolerance to fit that result:
the export gate should still detect an actual changed pixel, and regenerated
assets should not depend on the build host.

[The export tool](scripts/generate-app-icons.mjs) now uses fixed-point
area reduction with premultiplied colour. Source pixels span output-size units;
output pixels span source-size units, so overlap weights and colour sums are
integers. Sharp only decodes and encodes PNG. At the current source dimensions
the sums stay exactly representable in JavaScript. Transparent RGB contributes
nothing; opaque plates composite the background before the final rounding.
The gate again compares exact decoded RGBA, dimensions and channel policy.

The regression vectors cover transparent coloured pixels, opaque light/dark
plates, fractional reduction and enlargement refusal. The illustration itself
is unchanged by this pipeline correction; [its generation record](design/brand/agentdeck-icon.recipe.json)
keeps the image-tool prompts and source/output identities.
