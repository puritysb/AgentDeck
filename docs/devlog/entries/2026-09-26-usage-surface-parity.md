# 2026-09-26 — USAGE surface parity: one ESP32 row model, fleet-wide Luna, IPS10 cards

## Problem

The USAGE grammar the Stream Deck, D200H and IPS10 already followed (hide-if-absent,
z.ai MCP labelled by quantity, the Codex Luna reserve replacing exhausted windows,
the plan filling the slot a missing window leaves) had drifted on the other surfaces:

- ESP32 renderers each read raw `g_state` quota fields. Only IPS10 parsed the Luna
  reserve (and the serial whitelist only forwarded it to `ips_10`); the tank HUD,
  TTGO, T-Display-S3-Pro strip and Pocket hid z.ai MCP; plans were one footer chip
  that dropped the tier ("ChatGPT Pro" → "ChatGPT").
- TRMNL's usage band had no shared columns (Codex 7D started at a different x than
  Claude's), a fixed 30px tag that "MCP" overran, and only Claude carried a plan.
  The EPD47 Limits page drew Claude and Codex only.
- IPS10 drew 64px rings with the percentage crowding the arc, no brand marks, a
  visible scrollbar and "Claude Max - ~7/28" plan text.
- Apple and Android did not decode `lunaReserve` at all.

## Changes

- `esp32/src/util/usage_rows.h` — the one provider-grouped model every ESP32 USAGE
  surface renders from (tank HUD, TTGO, T-Display-S3-Pro, Pocket, IPS10, TRMNL/EPD47/
  NM e-ink, TC001 Codex page). `usage-presentation.ts` gained `usageSubscriptionTier`,
  generated into C++ and Swift.
- Luna is fleet-wide: state/protocol no longer gate it on `BOARD_IPS10`, and
  `prepareForSerial` forwards it to every board.
- IPS10: provider cards (brand mark, name, plan pill) with one-line window rows —
  label, faint countdown, percent — over a thick bar; four providers fit the
  landscape pane without scrolling.
- Grid surfaces put the plan in a free slot (`Plan  Pro · ~7/28`); small panels drop a
  later provider's second window before any provider's primary row.
- Apple (`CodexRateLimits.activeLunaReserve`) and Android (`activeLunaReserve`,
  `ProviderLimitRow.remaining`) render the reserve as "left" and colour it by the
  used complement.

## Measurements

- TTGO (no PSRAM) had 16 bytes of static DRAM headroom on master (124,564 of
  124,580). The first cut overflowed by 88 bytes; the usage cards now keep text in
  their labels instead of per-card copies, and the build uses 240 bytes less than
  master.
- IPS10 flash: 97.6% on master, 97.7% with this change (+4.3 KB).

## Live fleet deployment (same day)

- The live daemon reported Claude's subscription as the bare name "Claude", which
  the first tier rule echoed back ("CLAUDE Claude"). A prefix-only name now has no
  tier (`usageSubscriptionTier("Claude") === ""`) and a plan needs a tier or an
  expiry to take a slot. Sim scene `live-mix` reproduces that daemon's data.
- With the Node daemon stopped, the macOS app's Swift daemon opened the serial
  ports; esptool reported "serial noise"/checksum errors until the app quit.
- The deploy skill's 86 Box esptool fallback still said `--flash-size 8MB` and had
  no `boot_app0.bin`: the board boot-looped on `partition 3 invalid ... exceeds
  flash chip size`, then after the bootloader fix kept booting the old OTA slot.
  The skill now uses 16MB and writes otadata.
- After an OTA the daemon's device list kept showing IPS10's previous build; a
  direct `device_info` read under a serial lease showed the new one.

## Not changed

- Pixoo keeps showing the exhausted window: a 64×64 rail has no room to label a
  reserve percentage, so Luna would read as the 5h window.
