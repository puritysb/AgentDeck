# Vendored: Adafruit GFX core

These files are copied **unmodified** from the [Adafruit GFX Library]
(https://github.com/adafruit/Adafruit-GFX-Library), used by the ESP32 host
simulator so the TRMNL 7.5" e-ink text renders with the exact production glyphs.

- `Adafruit_GFX.{h,cpp}`, `gfxfont.h`, `glcdfont.c` — the GFX drawing core.
- `Fonts/FreeSans9pt7b.h`, `FreeSansBold{9,12,18}pt7b.h` — the FreeFonts the
  firmware's `eink_display.cpp` uses.

Only the display-agnostic GFX core is vendored — the hardware-coupled
`Adafruit_SPITFT` / `Adafruit_GrayOLED` are intentionally excluded. The e-ink
`GxEPD2_BW` shim (`sim/shims/GxEPD2_BW.h`) subclasses `Adafruit_GFX` and provides
only `drawPixel` (into a 1-bit host framebuffer).

**License:** Adafruit GFX Library is BSD-licensed; the copyright header is
retained in `Adafruit_GFX.cpp`. Copyright (c) 2013 Adafruit Industries.
