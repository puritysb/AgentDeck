# 2026-11-24 — Creature render audit: Antigravity color and Dot off duty

### What the user saw

On some devices the Antigravity creature was one flat color instead of the gradient mark. On the Pixoo 64, Dot looked like a gray saucer.

### Audit

Each surface was rendered from the real renderer, not from the source:

- a contact sheet of the Pixoo tide 64, standard 64, compact 32 and micro 11 paths across agents and Dot phases;
- the live daemon's `/pixoo/frame?size=64|32`;
- the ESP32 simulator for `ips10`, `t_embed`, `t_display_pro` and `amoled`;
- Stream Deck session keys from `renderSessionSlot`.

| Surface | Antigravity | Dot |
|---|---|---|
| Pixoo tide / standard 64, compact 32 | gradient (fine) | lone closed shell when off duty → gray saucer |
| Pixoo baked loop (Node) | gradient | 1-px-per-row habitat shell, the same saucer |
| iDotMatrix 32 / Swift `MatrixFrames` (`matrix-art.ts`) | **gray**: the mask was filled with `Brand.antigravity` (#5F6368, the wordmark gray) | neutral stand-in face on base scenes |
| ESP32 IPS10 workspace | **gray**: `COVER` recolor flattened the RGB565A8 gradient glyph | fine |
| Other ESP32 boards, Stream Deck/Ulanzi, Android | gradient | fine |

### Fixes

- `matrix-art.ts` paints Antigravity with the seven Pixoo-32 bands across the mask, and base scenes draw Dot's pearl. The generated Swift frames follow.
- In `ips10_workspace.cpp`, `tintFor()` recolors only `A8` masks. Full-color glyphs keep their colors.
- A one-cell beacon slot (`paintDotPixels` with `beacon: true`) keeps the pearl off duty at `restingBeaconAlpha` (0.45) and no longer draws the shell. The Swift `DotPixelOverlay` is generated with the same rule. The Node baked-loop overlay now uses the beacon.

The habitat shell remains on surfaces large enough to read it as a shell: the Swift Pixoo 64's camera-scaled sprite and the ESP32 terrarium.
