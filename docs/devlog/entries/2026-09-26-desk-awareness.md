# 2026-09-26 — Desk awareness across the small-device fleet

The user chose progress visibility without switching desktop screens, then
requested implementation and installation. Changes preserve the existing
usage-parity worktree and the IPS10/EPD47 recovery fixes.

- S3-Pro: landscape Focus is now the boot default on both camera/no-camera
  units; CAM remains an explicit page. Initial focus is pinned, local activity
  observation age is shown, and actual chat responses are retained separately
  from questions and tool activity. The first result appears automatically;
  a later result is explicitly offered for replacement.
- T-Embed: default full roster, readable activity instead of a large decorative
  carousel. Turning selects locally, pressing opens local detail, and shared
  desktop focus is not published or allowed to overwrite a manual choice.
  Waiting remains in the queue/status ring, without taking over the list.
- EPD47: work/response sheet plus stable session summaries in the right column;
  quotas remain on the explicit LIMITS page. TRMNL and NM share response-only
  recent results. Requests no longer masquerade as completed results.
- iDotMatrix/Timebox: Node serves new native 32/11-pixel signals. Waiting count,
  errors, 90-second explicit result indications, working and idle are distinct.
  High quota usage is not an error. Only waiting animates; missing roster data
  is distinct from idle. Pixoo64 keeps its existing renderer.

The layout proposal and precise scope are in
[companion concepts](docs/esp32-companion-concepts.md#desk-awareness-2026-09-26).
The native Swift BLE path still uses its prior renderer; this desk's installed
Node daemon owns both BLE devices. The installed daemon's changed JS modules
were backed up and copied from this worktree's validated build, leaving shared
master source untouched. That temporary deployment was subsequently replaced by the integrated master
build (see the integration follow-up below).

Verification: all five firmware builds; actual-renderer simulator previews;
T-Embed local-selection and roster-reorder simulation; five new signal tests;
full JS suite 4,757 passed/two skipped after updating the TRMNL preview mirror;
six native tests. Diagnostics/build/flash receipts are under the ignored
`diagnostics/desk-awareness` directory. No commit or merge was requested.

Installation completed on the desk: USB flash regions hash-verified for
S3-Pro (epoch 1790416734), T-Embed (1790416807), EPD47 (1790416645),
and NM-EPD-420 (1790416614). TRMNL WiFi OTA completed with 1,536 chunks;
direct device_info confirmed epoch 1790416583 after reboot. All five reported
four live sessions. EPD47 repaint count advanced from 5 to 8 without reboot,
with largest internal block 30 KB; free internal heap was 99 KB on serial and
66 KB while WiFi was active. Its persistent-worker regression passed 100 draws
and 1,500 phases without render allocation. S3-Pro and T-Embed reported healthy
current free heap (57/60 KB) but low historical minima (3/4 KB), so this is not
a long-duration memory stress qualification.

Both BLE panels reported connected, a delivered frame, and no transport error.
Normal launchd Node daemon (PID 3090, build 4a7bab28ae2b) remains on port 9120;
serial lease was explicitly released after OTA. Physical panels cannot be
captured here: validation used firmware receipts, repaint counters, BLE delivery
and actual-renderer simulator images, not direct observation of the glass.

Integration follow-up: at the user's request, commit `85ca5896` preserved all
60 changed/new source files, including usage parity and both display recoveries.
Master fast-forwarded without conflicts; SHA-256 comparison confirmed all 60
files matched the pre-integration worktree. Master rebuilt successfully. The
worktree and ignored diagnostics remain available; unrelated local browser
artifacts and other task worktrees were preserved.
The restarted launchd daemon (PID 25828, port 9120) reported build
`a1ebf5d83122`, exactly matching the master dist digest. All 11 serial boards
and both BLE panels reconnected. The temporary copied-module dependency is gone.
