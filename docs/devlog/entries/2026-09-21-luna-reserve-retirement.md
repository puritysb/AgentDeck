# 2026-09-21 — Retire Luna reserve after Codex quota recovery

## Problem and change

After a Codex reset, ordinary quota was available but cached Luna metadata could
still replace the ordinary gauges. The live/passive chooser copied reserve
metadata in both directions, including into a fresh live answer without Luna.

The live parser now activates reserve only when an ordinary window is exhausted.
A chosen live response cannot inherit an older passive reserve. Passive readings
can retain live reserve metadata only while ordinary quota remains exhausted.
Wire normalization removes reserve after ordinary quota recovery or expiry while
preserving the ordinary Codex snapshot and its capture time.

## Verification

Six regression cases cover recovered quota, authoritative absence, passive carry,
and expired windows. Build and typecheck passed; 303 test files passed with
4,665 tests passed and two skipped. Protocol generation left no tracked drift;
all seven design-token mirrors agree. Runtime installation and release soak
remain separate release gates.

## Release continuation

Ulanzi's existing pending review was updated in place to 1.4.0. Readback verified
the new uploaded ZIP, all seven original localized listings, and keypad-only
support (Dial excluded). Tag `ulanzi-v1.4.0` follows the submission at `1c1f51b7`;
Ulanzi Release run 35599883103 succeeded. Marketplace approval remains pending.

ESP32 run 35549924262 failed in the IPS 10 hybrid build: its second stage launches
`~/.platformio/penv/bin/pio`, whose unpinned pioarduino distribution resolved to
6.2.0 despite the system PlatformIO 6.1.19 pin. The workflow now preinstalls
pioarduino 6.1.19 in that same environment and uses it for both stages. A fresh
release run is still required to validate the complete matrix.
