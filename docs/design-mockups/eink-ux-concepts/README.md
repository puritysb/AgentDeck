# ESP32 e-ink UX concepts

Initial image-first direction for the AgentDeck e-ink surfaces (2026-08-30).

- `first-party-surfaces.png`: TRMNL 7.5" as an always-on live board, EPD47 as a focused work sheet, and NM-EPD-420 as a slow-refresh decision station.
- `xteink-pocket-daily.png`: XTeink X3/X4 as an offline-first Pocket Daily companion rather than a scaled AgentDeck dashboard.
- `first-party-interaction-limits-v2.png`: revised first-party surfaces with explicit touch/button capability and a shared Claude/Codex limit language.
- `xteink-interaction-limits-v2.png`: revised non-touch X3/X4 interaction, cached limit cards, absolute reset times, and stale-snapshot treatment.
- `epd47-autonomous-touch-v3.png`: EPD47-only storyboard using the actual wide T5 4.7-inch hardware proportion, GT911 touch navigation, and autonomous page arbitration.

XTeink X3/X4 concepts are parked after v2. Their AgentDeck surface is expected to become an optional menu inside the separately developed Pocket Daily firmware, and they are outside the current ESP32 e-ink redesign scope.

## Interaction assumptions in v2

- TRMNL 7.5" is non-touch: `KEY1` pages and `KEY2` returns to the live AgentDeck board. `GLANCE` is an internal policy name and is never used as the product title.
- NM-EPD-420 is non-touch: on the home view `BOOT` pages/opens and `USER` returns home; on a decision `BOOT` advances and `USER` selects then confirms. The unfinished microphone path is not advertised on-screen.
- EPD47 exposes touch hardware only when detected. The firmware probes current GT911 (0x14/0x5D) and legacy 0x5A controllers and reports diagnostics in `device_info`; when no controller answers, the User button cycles the three tabs so the surface remains operable.
- XTeink X3/X4 are non-touch readers. X3 maps four logical actions onto two front rockers; X4 has four independent front keys.

Limit bars always mean **used**, show an absolute reset time, and carry an `AS OF` timestamp. A binding scoped-model limit outranks aggregate provider windows. A frozen but still relevant value remains visible as `LAST KNOWN`; an ended window is `STALE`.

## EPD47 autonomous page policy explored in v3

- No active durable work: retain `LIMITS` as the useful resting page.
- One meaningful active task: move to `FOCUS` on a durable boundary, not on tool-log churn.
- Two or more active tasks: move to `QUEUE`.
- A real structured input request: show `DECISION` as the highest-priority page.
- A user tab tap or action opens an eight-minute manual hold. During the hold, new work is announced in the status band rather than stealing the body.
- Touch operates while the board is awake. GPIO21 remains the wake control and becomes the tab-cycle fallback when the GT911 is unavailable because the touch IRQ is not a deep-sleep wake source on the current wiring.

The v3 direction is implemented in the board renderer. The concept image remains non-pixel-accurate; host-simulator frames and physical-panel inspection are the validation artifacts for exact geometry, text metrics, button mapping, waveform constraints, and capability enablement.
