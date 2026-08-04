# ESP32 host simulator

Render **real** AgentDeck ESP32 board screens on your Mac/Linux host — no board,
no flashing. The simulator compiles the firmware's render surfaces (LVGL
terrarium + HUD, the "pixel office" tablet layout, the TC001 LED matrix, and the
InkDeck e-ink dashboard) against a host toolchain, into an in-memory framebuffer
that is dumped to PNG.

Because it reuses the firmware sources **verbatim** with each board's build
defines (`SCREEN_W/H` + `BOARD_*`), the output is **pixel-exact** with what the
physical panel shows — it is that board's firmware minus hardware I/O, not a
hand-drawn approximation. This is the ESP32 counterpart to the Node preview tools
(`bridge/scripts/pixoo-preview.ts` et al.) that reuse the production renderers,
and it removes the drift risk of the hand-mirrored Swift Device Preview ESP32
tiles (`apple/.../UI/Preview/Devices/EinkEsp32Previews.swift`).

## Quick start

```bash
cd esp32/sim
./render.sh                 # all boards, all scenes → sim-out/*.png
./render.sh box_86          # one board, all scenes
./render.sh box_86 working  # one board, one scene
```

Requires PlatformIO (`pio`) — same tool the firmware uses. LVGL and (for the
e-ink) the Adafruit GFX fonts are handled automatically (LVGL via `lib_deps`
pinned to the firmware's `lvgl@^9.2.0`; the GFX core + fonts are vendored under
`vendor/adafruit_gfx/`).

Under the hood:

```bash
pio run -e box_86                                       # build the host binary
.pio/build/box_86/program --all --outdir sim-out        # render every scene
.pio/build/box_86/program --scene working --out out.png # one frame
```

## Boards

| env       | board define    | resolution | surface                                            |
|-----------|-----------------|------------|----------------------------------------------------|
| `box_86`  | `BOARD_BOX_86`  | 480×480    | 86Box 4" — terrarium + HUD (flagship)              |
| `ips35`   | `BOARD_IPS35`   | 480×320    | IPS 3.5" landscape — terrarium + HUD               |
| `amoled`  | `BOARD_AMOLED`  | 360×360    | Round AMOLED — terrarium + HUD (circular mask)     |
| `ttgo`    | `BOARD_TTGO`    | 135×240    | TTGO T-Display — compact terrarium + overlay strip |
| `ips10`   | `BOARD_IPS10`   | 1280×800   | Guition 10.1" — "pixel office" + HUD sidebar mosaic |
| `t_embed` | `BOARD_T_EMBED` | 320×170    | T-Embed CC1101 — encoder "Companion Knob" (`ui/knob/`) |
| `t_display_pro` | `BOARD_T_DISPLAY_PRO` | 480×222 | T-Display-S3-Pro — "Focus Strip" (`ui/ticker/`), camera-less unit |
| `led8x32` | `BOARD_LED8X32` | 8×32 (×16) | Ulanzi TC001 WS2812B matrix — usage/agents pages   |
| `inkdeck` | `BOARD_INKDECK` | 800×480    | Seeed InkDeck 1-bit e-ink dashboard (UC8179)       |

The LCD boards render the **real composed screen** via each board's own render
tree — `Screens::aquariumCreate()` (Terrarium+HUD / Office / TTGO overlay),
`Knob::create()` or `Ticker::create()` — not a hand-assembled approximation. The
matrix (`--page usage|agents`, upscaled ×16) and e-ink are LVGL-free and use
their own render paths.

### Layout-diagnostic envs (not published)

`xteink_x3` (528×792) and `xteink_x4` (480×800) render the **AgentDeck** e-ink
tree at the XTeink readers' panel sizes. Those readers run the community
CrossPoint fork, whose own `GfxRenderer` draws their glyphs — only the
responsive geometry SSOT (`src/ui/eink/eink_dashboard_layout.h`) is shared
byte-identically. So these envs show how the shared geometry composes at those
dimensions (X3's 528px short edge is the only `Regular` density band any render
exercises) and are the cheap way to inspect it without the fork's hardware — but
their output is **not** that fork's screen. They are excluded from `render.sh`'s
default set and from the Pages demo for that reason; ask for them by name.

**Adding a board:** copy an env block in `platformio.ini` and set the target's
`BOARD_*` / `SCREEN_W` / `SCREEN_H` defines to match the real env in
`esp32/platformio.ini`. The LVGL display buffers are stride-aware, so widths that
aren't a multiple of 16 (TTGO 135/144, etc.) work without extra changes.

## Scenes

`empty` (pre-connection), `idle`, `display-off` (idle dashboard with the host
Mac display asleep), `working`, `multi` (Claude + Codex + OpenCode + Antigravity
+ OpenClaw gateway crayfish), `permission` (awaiting → "?" bubble). Scenes
populate the same `g_state` the firmware fills from the daemon's `state_update`,
so they exercise the real session → creature/card derivation. On InkDeck,
`display-off` intentionally renders byte-identically to `idle`; the e-ink panel
keeps useful status visible when the host monitors are off.

There is also a parameterized scene family `demo:<agent>:<state>` (agents:
`claude|codex|opencode|openclaw|antigravity`; states:
`idle|working|asking|sleeping`) that mirrors the creature-simulator web demo's
agent × state matrix — session shape and usage values match
`scripts/render-creature-simulator.mjs`, so the GitHub Pages `/demo` ESP32
panels are rendered from these scenes (`scripts/render-esp32-sim-frames.mjs`,
invoked by `pnpm run demo:build`). `--all` renders only the named catalog above;
demo scenes are requested explicitly via `--scene`.

Frames are deterministic: the PRNG is re-seeded per run and the clock is virtual,
so `--out a.png` twice produces byte-identical PNGs (suitable for golden tests).

## How it fits together

```
sim/
  platformio.ini        # native envs (one per board) — NOT inheriting esp32/platformio.ini
  render.sh             # build + render wrapper
  vendor/adafruit_gfx/  # vendored Adafruit GFX core + FreeFonts (e-ink text; MIT)
  shims/                # host stubs for the hardware surface the render code touches
    Arduino.h           #   millis/Serial/map/random/ps_malloc/String/pin+math macros
    esp_heap_caps.h     #   heap_caps_* → malloc
    freertos/*.h        #   SemaphoreHandle_t + no-op mutex
    FastLED.h WiFi.h    #   CRGB buffer (matrix) + WiFi stub
    Print.h SPI.h       #   Print base (Adafruit_GFX) + SPI stub (e-ink)
    GxEPD2_BW.h         #   e-ink display: Adafruit_GFX subclass → 1-bit host framebuffer
    U8g2_for_Adafruit_GFX.h  # CJK text stub
    net/*.h             #   Net:: serial/wifi status (→ connected)
  src/
    sim_main.cpp        # CLI: board-branched (LCD / matrix / e-ink) render loops
    sim_display.cpp     # headless LVGL display → in-memory RGB565 framebuffer (stride-aware)
    png_writer.cpp      # RGB565 → PNG (self-contained: stored DEFLATE + CRC32/Adler32)
    mock_scenes.cpp     # named g_state presets
    sim_globals.cpp     # host defs of firmware globals (g_state, g_screenW/H, fonts, Net::, UI::)
    fw/*.cpp            # LCD unity-include wrappers → ../../src/ui/{screens,terrarium,widgets}/*
    mtx/*.cpp           # TC001 matrix wrapper + render (CRGB → upscaled PNG)
    eink/*.cpp          # InkDeck wrapper (+ SimEink render) + vendored Adafruit_GFX compile
```

The firmware sources are **never copied**: each wrapper (`fw/`, `mtx/`, `eink/`)
is a one-line `#include` of the real `../../../src/...` file. That pass-through
matters for correctness — compiling the firmware sources through the sim's own
`src/` gives each env a **per-env object dir** (`.pio/build/<env>/`) so board
`#if` branches (`IS_ROUND`, canvas format, `MAX_*`) take effect independently.
Referencing them via a `build_src_filter` `../..` path instead lands one shared
`.pio/build/src/` object that freezes those branches to whichever env built first
(e.g. the round AMOLED mask leaking onto rectangular boards). Per-env
`build_src_filter` keeps each board compiling only its own surface (LCD → `fw/`,
matrix → `mtx/`, e-ink → `eink/`).

## Fidelity notes / limitations

- **Latin labels only.** The CJK fallback font isn't bundled; Korean session
  names render as `.notdef` boxes (Latin labels are pixel-identical). The e-ink's
  U8g2 Korean path is stubbed for the same reason.
- **e-ink is a single full-buffer pass.** The real panel's partial-refresh
  ghosting/timing is not modeled — the sim shows the final composited frame.
- The vendored `vendor/adafruit_gfx/` is the upstream Adafruit GFX core + four
  FreeFont headers (BSD/MIT, license headers retained), used only so the e-ink
  text renders with the exact production glyphs on the host.
