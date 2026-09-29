# 2026-09-27 — One session-state palette and vocabulary across every Dashboard

A design-system audit found that the same working session was painted
differently on each Dashboard: green on the macOS Monitor, cyan in the menu bar,
blue on the Android tablet, TUI and most ESP32 boards, and teal on a Stream Deck
key. Idle was grey on the Mac and green everywhere else. There were two
competing "canonical" palettes, DESIGN.md §2.7 and a Tailwind table in
`shared/src/state-colors.ts`, and each platform held its own copy of the latter.
`design/lint.sh` could not see the drift because it reads only web files.

Decision: one meaning per hue. Green is health (link up, quota normal), cyan is
activity (an agent working, and the product chrome), amber is "needs you" and
the only hue that pulses, red is failure, and grey is quiet or unknown. Idle
became neutral because a roster full of green idle rows hid the rows that were
working. Working became cyan rather than green because green already means
health. It is not blue because blue read as the Codex brand next to a Codex
mark. This matches the menu bar, the creature spark grammar and the IPS10
design, which had already chosen it.

- New `--session-*` tokens in `design/tokens.css` (with the HUD `--ui-hud-*`,
  aquarium `--ui-water-*` and `--brand-opencode-on-dark`) across all seven
  mirrors.
- `shared/src/session-state-presentation.ts` owns state to tone, dark/paper
  colour, and the words (`Working` / `WORKING` / `WORK`, and so on).
  `pnpm generate-session-state` emits the Swift, Kotlin and ESP32 mirrors and
  `esp32/src/ui/product_palette.generated.h`, the first C++ token mirror.
- The following consumers now bind to it: Apple Monitor, menu bar, status
  badge, Pixoo renderer and TRMNL preview; the Android LCD theme, Monitor,
  settings dialog and e-ink; ESP32 TTGO, IPS10, ticker, pocket, knob/ring and
  e-ink; the TUI; and the hook-server status page. On the Stream Deck/D200H key
  renderer, only the awaiting amber follows the SSOT (Node and Swift). The key
  layout is unchanged.
- The Android e-ink serif and the Apple SF Rounded uses were dropped
  (DESIGN.md §3.3: two roles, no third design). An Apple HUD text colour that
  had been hand-copied as `#E2E8E0` instead of `#E2E8F0` is fixed by the same
  binding.
- New gate: `scripts/__tests__/native-palette.test.ts` ratchets raw colour
  literals in native Dashboard code
  (`design/native-palette-baseline.json`: 282 on master, 159 after this change).

Remaining, and deliberately out of this change: ESP32 LVGL Montserrat on the
ticker, pocket, knob and TTGO state screens (switching to Plex needs per-board
flash budgets and on-device review), timeline event-type category colours,
the light "paper" attention card on the Apple menu bar, and the Stream Deck key
palette beyond awaiting.
