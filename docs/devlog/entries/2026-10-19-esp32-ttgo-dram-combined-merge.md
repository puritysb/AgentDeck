# 2026-10-19 — ESP32: two green PRs left master's TTGO 8 bytes over static DRAM

**What was seen.** On master `f3f935fd`, `pio run -e ttgo` stops at the link:
`region 'dram0_0_seg' overflowed by 8 bytes`. #565 (stop mDNS before the radio
goes off) and #566 (allocation-failure telemetry) merged 8 seconds apart on
2026-10-18. Each had passed the `ESP32 TTGO Compile` job, but against a master
without the other. Nothing reported the combined failure:
[.github/workflows/esp32-sim.yml](.github/workflows/esp32-sim.yml) ran only on
`pull_request`, and no other workflow builds the TTGO target. It would have
surfaced at the next `esp32-v*` tag, or as a red TTGO job on the next PR touching
`esp32/**`, which would then have looked like that PR's fault.

**The budget.** `dram0_0_seg` is 124,580 B (`0x1e6a4`) on this classic-ESP32
board, and static data fills it to the last kilobyte. The largest symbols:

| Symbol | Bytes |
|---|---|
| `ttgo_canvas_buf` | 46,080 |
| `g_state` | 13,152 |
| `port_IntStack` (FreeRTOS) | 4,192 |
| `serialBuf` | 4,096 |
| `g_cnxMgr` (WiFi) | 3,880 |
| `outbox` | 1,920 |

**The fix.** The terrarium's sine table moved to flash. It was a 256-float
array that `fastSin()` filled on first use, so it occupied 1,024 B of static
DRAM on every board. It is now computed at compile time (a constexpr Taylor
series, |x| ≤ π, error below 2e-13) into `.flash.rodata`. In the map it sits at
`0x3f514368`, size `0x400`. The TTGO static end is now 1,016 B below the region
end. Every caller reads the same values at the same index. The table is
read-only, so the old first-use fill, which two tasks could race, is gone. It is
reached only from flash-resident render code, which never runs while the flash
cache is off, so reading it from flash adds no constraint.

**The gap, closed.** `esp32-sim.yml` now also runs on master pushes, diffed
against the tip the push replaced. A master that two PRs broke together goes
red within one run instead of waiting for a tag. Making GitHub require PR
branches to be up to date before merging would prevent the break rather than
report it. That is a branch-protection setting, so it is left to the owner.

**Headroom is now a number to watch.** 1,016 B is one more buffer the size of
`otaChunkBuf`. A change that adds static data on TTGO should read the map
(`.pio/build/ttgo/firmware.map`, the `dram0_0_seg` length against `_heap_start`)
rather than rely on the link succeeding.
