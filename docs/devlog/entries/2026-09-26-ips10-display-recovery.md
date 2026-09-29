# 2026-09-26 — IPS10 display, WiFi and internal heap recovery

## Failure and evidence

The usage-parity rollout left IPS10 with a blank/stale panel, PPA rotation errors,
WiFi initialization `ESP_ERR_INVALID_ARG`, and ~0–1 KB internal heap. A user power
cycle did not repair the software faults. The user subsequently confirmed the
screen and cards were visible after the first recovery firmware.

Three independent fixes were required:

- IDF 5.5 checks PPA output alignment against the external cache alignment even
  when the output is internal RAM. The hard-coded 64-byte allocation was invalid
  on this SDK (128 bytes). Query the SDK alignment and round the allocation size;
  if hardware rotation fails, transpose and draw the same frame on the CPU and
  latch the fallback rather than dropping every frame and flooding serial logs.
- The hybrid custom SDK rebuilt managed component archives, but Arduino compiled
  against older packaged headers. `wifi_init_config_t` gained
  `wifi_task_stack_size` before `magic`; mismatched offsets caused the rejection.
  `ips10_sdk_headers.py` prepends the matching managed-component headers in SDK
  order without editing the shared PlatformIO package. Keep the hybrid project's
  `managed_components` with its SDK build; when regenerating the custom SDK,
  remove generated sdkconfig files as described in platformio.ini.
- LVGL object/style/cache allocations consumed the remaining internal heap.
  IPS10 now uses a PSRAM-only LVGL custom allocator; draw and rotation buffers
  keep their explicit internal DMA allocation. The workspace no longer consumes
  the network's internal RAM reserve. Added a `ui-ready` heap checkpoint.

The first rotation-only recovery still reached ~0 KB and failed WiFi. After all
three fixes, boot connected to WiFi, UI creation left 82 KB internal RAM, and
live data held 81–83 KB free (78 KB low watermark during the initial capture).
Workspace update counts increased 23 → 61 → 99 with four sessions and five quota
windows. No PPA errors or panic appeared in that capture. This separates the
rendering, SDK ABI and allocation faults; it is not a master/branch A/B claim
about how much RAM the previous card design used. At the final 188-second
check, internal heap remained 82 KB (68 KB low watermark, 16 KB largest block),
WiFi stayed connected, and workspace updates reached 685 without reboot.

## Deployment

Python esptool 5.3 with default reset and its stub successfully wrote and
hash-verified bootloader, partitions, otadata and application over the existing
CH340 UART at 460800 baud. P4 rev1.3, MAC 80:f1:b2:d0:b4:bb, flash 16 MB.
Bootloader offset is 0x2000. The August USB limitation in the registry was stale;
Python upload flags and deploy instructions now reflect the measurement.
Browser esptool-js remains unverified and disabled.

Installed firmware identity: cb4d0c57-dirty, build epoch 1790412803. All changes
remain in the existing usage-parity worktree. The normal launchd daemon was
restored on port 9120. Its ignored compiled `esp32-serial.js` and source map were
updated only with the verified Luna-forwarding change (backup in diagnostics),
so all boards retain Luna while the source change awaits integration. Rebuilding
master before integrating this branch will overwrite that temporary deployment.

## Recent-work review and validation

- Explicit zero-minute Codex credit quotas were incorrectly labelled 5h/7d by
  the new shared row helper. They now say Credits; absent legacy minutes still
  default to 300/10080 in the parser. Added native semantic regression coverage
  for credits, absent windows, plan-only slots, bare Claude names and Luna.
- All six native test executables passed. JS suite: 4,751 passed, two skipped,
  one concurrent live-port suspend test failed; all seven tests in that file
  passed on isolated rerun. Board SSOT checks: 15 passed after upload updates.
- pnpm build/typecheck, protocol-generation drift check, token synchronization,
  documentation and design-system checks passed. Simulator sheets from the live
  data rollout were reviewed; no major card clipping/overlap was found. Other
  physical panels were not directly visible to this diagnostic session.
- Design lint on tracked files remained at the same 89 violations as master;
  generated/ignored files account for the different unfiltered totals.
- No new Apple or Android binary was built in this recovery pass. The credits
  correction is installed on IPS10; other boards retain the prior rollout build.

Raw local evidence is under diagnostics/ips10-recovery (ignored), including
final-boot.log, soak.log, build-sdk.log and flash-sdk.log.
