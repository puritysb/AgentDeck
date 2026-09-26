# 2026-09-26 — EPD47 white-panel recovery and desk-awareness direction

The user reported EPD47 repeatedly becoming entirely white. Direct serial
telemetry showed the firmware was alive for 4,676 seconds and receiving sessions,
but repaintCount/fullRefreshCount were both stuck at 1. Touch initialization had
not run. Internal heap was 40 KB, largest block 6 KB, low watermark 0 KB.

The pinned LilyGo driver erased the panel before `epd_draw_image`, which created
two 8 KiB tasks on every one of 15 grayscale phases, ignored task-creation
failure, and then waited forever on their completion semaphores. A fragmented
heap could therefore leave a white panel with the network task still healthy.

`esp32/scripts/epd47_driver.py` applies a checked, idempotent patch to the pinned
library. Two workers and their semaphores are created once at driver init,
before panel erase, and reused through task notifications. Creation failures
are checked before panel power-on. The 64 KiB CPU lookup table moves to PSRAM;
worker stacks and the driver's DMA buffers remain internal. Rendering no longer
allocates/deletes worker tasks or semaphores. Only the EPD47 environment uses
this patch; a changed upstream source fails the patch instead of silently
skipping it.

USB full-flash hash verification passed. Runtime identity is cb4d0c57-dirty,
build epoch 1790414056. Afterward repaintCount reached 2, touchReady became true
(GT911 at 0x5d, RTC seen), and serial-primary heap was 99 KB with a 30 KB largest
block and 52 KB low watermark. WiFi connected before serial became primary;
radio parking afterward is intentional. Serial suspend was released and the
normal daemon remained running. At 157 seconds the repaint count advanced to 3
and heap remained 99 KB; physical panel confirmation was requested separately.

Validation: EPD47 release build; a host harness executes the actual patched draw
dispatcher for 100 images/1,500 phases without providing any allocation APIs;
six native test executables; pnpm build/typecheck/test (4,752 passed, two skipped);
protocol generation without drift; token synchronization; docs/design-system
checks. Tracked design lint stayed at the existing 89 violations. Local evidence is in diagnostics/epd47-recovery (ignored).

The user clarified the main hardware need: see progress while working without
switching the desktop screen. The proposed per-device defaults are recorded in
[companion concepts](docs/esp32-companion-concepts.md#desk-awareness-2026-09-26).
They prioritize one pinned task on S3-Pro, tactile parallel-session inspection
on T-Embed, a stable work sheet on e-ink, and large attention signals on LED
matrices. These role changes are proposals, not deployed UI.
