# 2026-09-27 — Consistent quota severity across dashboards

## Problem and policy

The same subscription window could be red above 80% on Stream Deck/Ulanzi,
amber above 70% on native dashboards, or still provider-colored on TTGO/TC001.
The shared policy now classifies consumed capacity as normal below 70%, warning
from 70% to below 90%, and critical from 90%. A remaining value uses its consumed
complement: 18% left and 82% used are both warning. Design contract:
[DESIGN.md](DESIGN.md#28-subscription-quota-severity).

`shared/src/usage-severity.ts` binds existing product tokens and generates the
Swift, Kotlin and C++ policy/palette. The dark paper palette preserves contrast
on light backgrounds. Brand identity remains separate from numeric severity.

## Surfaces

Stream Deck, Ulanzi, native Apple/Android dashboards, terminal gauges, Pixoo and
iDotMatrix now share the policy. Luna percentage text follows used capacity.
Quota-driven red flashing was removed; actionable agent attention is unchanged.
TTGO shows a colored number over a dark card and a separate solid bottom rail,
with a larger number for medium-height cards. TC001 retains its provider mark,
uses a neutral window label, and colors the number and rail. `LU` leaves enough
space for the Luna reserve's `100%` without clipping. IPS10 uses the same color
for its number and bar. Monochrome and black/white/red e-ink keep their hardware
palette limitations with the same critical boundary.

## Verification

- Shared threshold, unknown/inactive, text-contrast and generated-mirror gates.
- Stream Deck/Ulanzi regression: 82% used and 18% remaining are amber; 90% is red.
- Native C++, Swift and Kotlin boundary tests; host firmware simulator frames
  for TTGO and TC001, including the remaining-capacity path.
- TypeScript suite: 4,835 passed, 2 skipped. Protocol generation unchanged.
- Android signed sideload build and quota unit test; macOS build and quota test.
- Runtime rollout receipts are recorded after installation; simulator frames
  prove render output, not physical panel appearance.
