# 2026-09-22 — Install the Android candidate on both physical readers

Connected Pantone 6 (`AA007422R24C1300039`) and Crema S (`CREMAA21W09235`) were updated in place from 1.2.0/code 15 to signed 1.4.1/code 19. Package read-back, running processes, USB reverse connection on 9120, live sessions and GLM/MCP gauges were verified on both. Pantone landscape was preserved; Crema retained its portrait/system rotation settings. The APK includes manual wireless app updates but their newer-public-release installation path has not been exercised.

The physical readers retain the simple e-ink environment: the Blender habitat in this candidate is intentionally LCD-only. This installation does not validate the Blender artwork on EPD or prove optical animation/ghosting quality; ADB captures show composed pixels, not the panel response.

Crema exposed an actual refresh failure: repeated `sys.eink.update=A2` writes fail with permission denied. Its manufacturer reports `IWG` and board platform `sdm660`, contrary to older notes identifying this particular reader as RK3566. The Rockchip route therefore cannot be assumed for this device. A working vendor refresh API and elimination of repeated denied fallback calls remain follow-up work. Pantone's inspected recent process log had no matching refresh exceptions; that alone does not prove successful optical partial updates.

No app source change, new public release or new store submission was made during this installation. Optical feedback was requested from the user.
