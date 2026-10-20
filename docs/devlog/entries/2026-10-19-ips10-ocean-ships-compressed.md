# 2026-10-19 — The IPS10 ocean ships compressed, freeing 415 KiB of OTA slot

**What was found.** The IPS10 app image was 6,238,896 B in a 6,291,456 B OTA
slot (99.2%), so the next feature over 52 KiB could not be updated over the air.
Changing the partition table needs a USB full flash, and the merged image wipes
NVS, so the slot size is fixed for boards in the field. `nm` on the ELF put
4.59 MB in `.flash.rodata`. Most of it was three Hangul fonts (about 3.2 MB) and
`IPS10Ocean::pixels`, the 640×400 RGB565 background stored raw at 512,000 B.

**Now.** `design/ips10/encode_ocean.py` stores the background as one zlib
stream of 86,363 B, which inflates byte for byte to the previous pixels (checked
against the header on master). `oceanImage()` in `ips10_workspace.cpp`
inflates it once into PSRAM with the ROM `tinfl_decompress`. The inflater state
lives in PSRAM and is freed right after, since it is too large for the loop
stack. The scaled screen was already cached in a PSRAM canvas, so the source
image is a cold-path read like that cache. If PSRAM or inflation fails, the
screen keeps its plain fill.

**Measured.**

- `firmware.bin` went from 6,238,896 B to 5,813,728 B, so slot use fell from
  99.2% to 92.4%.
- Flashed over Wi-Fi OTA to the desk IPS10, build `3987bf1c-dirty`. The boot log
  shows `[HEAP] ips10-ocean-image`, which is printed only after a successful
  inflate. PSRAM free fell by about 515 KB, internal free stayed at 84 KB with
  a 33 KB largest block, and `allocFailures` stayed 0.

**Not covered.**

- The screen was not inspected by eye.
- The fonts are the larger lever. Compressing them would change the glyph
  render path, so they need an on-device visual check first.
