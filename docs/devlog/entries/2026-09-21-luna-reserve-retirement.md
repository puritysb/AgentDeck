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

## Installed verification and remaining gates

PR #358 merged at `2b195cf9` with all six CI checks passing, including the clean
source design-lint regression gate. Installed four candidate tarballs through
`/opt/homebrew/bin/agentdeck`; version 1.4.0, Node 26.5.0 ABI 147, native SQLite
ready. The first supervised restart did not become ready; an explicit supported
`daemon start` succeeded. Build `1c024aad5273` emitted weekly quota 22% with no
`lunaReserve`. The 1.4.0 development-signed Release app (build 4, same Apple
source as submitted build 7001) attached and showed the normal weekly gauge.

Coexistence soak is **not passed**. After stopping CLI, the app observed a real
read-only Codex pwd turn but bound fallback 9121. At 12:46:06Z it attempted to
reclaim 9120; at 12:46:11Z NWListener returned EADDRINUSE again and it moved to
9122. BSD bind with SO_REUSEADDR succeeded while no 9120 listener was present.
This does not establish the underlying cause or downstream turn delivery.
The test app was quit and the installed fixed CLI restored: PID 55165, build
`1c024aad5273`, sole listener on 9120. npm 1.4.0 remains unpublished pending a
successful three-mode gate; no waiver is inferred.

Android AAB 1.4.0 (18) was uploaded to Google Play with en-US/ko-KR/ja-JP notes,
saved and explicitly sent for review. The publishing overview reported
**changes under review**, with Google's automatic prechecks still running.
100% rollout and all existing countries were retained. The only bundle warning
was missing native debug symbols; R8 mapping is attached. This is submission,
not evidence of approval or public availability.

No ESP32 1.4.0 release existed after either failed attempt. The unpublished tag
was moved with an exact force-with-lease from `00c94531` to `2b195cf9`, starting
run 35601175941. Its full matrix remains unverified while running.
