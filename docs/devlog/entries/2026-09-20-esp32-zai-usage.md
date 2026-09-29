# 2026-09-20 — z.ai gauges across the ESP32 fleet (#350)

The firmware now parses the `zaiRateLimits` block (primary 5h credits +
secondary long window with the `quantity` flag) and renders it on every usage
surface, always labeling the MCP tool-call quota by its QUANTITY — "MCP" —
never a window length, so it can never read as token usage.

- **Wire/state**: `protocol.cpp` parses the block into
  `zaiPrimary/SecondaryPercent` + `zaiSecondaryIsMcp` (−1.0f sentinels, same
  grammar as Codex); `device_info` and the serial status echo carry
  `usageZai5H/7D`.
- **Surfaces**: TTGO usage screen 4→6 adaptive cards; HUD-bar tank panel grows
  a third Z.AI block (its long gauge relabels to "MCP" per quantity); Pocket
  and Ticker usage pages carry the Z.AI rows; the TC001 matrix gains a
  `Page::ZAI` gauge pair, auto-skipped with no data; the e-ink family
  (TRMNL 7.5", EPD47, NM) renders a Z.AI provider row with plan + windows and
  the MCP label through a `secondaryLabel` parameter on the shared
  `drawProviderUsage`, with the EPD47 mini-gauge stack extended.
- **Identity**: `creature_glyphs` now rasterizes the upstream z.ai mark
  (design/brand/zai.svg) into the 64×64 alpha mask; `Theme::ZaiBlue`
  (#1F63EC) is measured from the same asset.
- **E-ink content hash** includes the new fields, so a z.ai reading arriving
  on a connected panel earns a refresh.

Fleet compile green on all 12 envs. `lilygo_epd47` USB-flashed and verified on
the live daemon (v1.3.0 a5556d37-dirty serving alongside the wire probe); the
rest of the fleet updates via the release OTA round (binary delta required).
