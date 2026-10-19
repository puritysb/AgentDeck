# 2026-10-18 — ESP32: keep 16 KB of internal RAM where malloc cannot reach it

**Why.** The allocation-failure counter
([2026-10-18 entry](docs/devlog/entries/2026-10-18-esp32-alloc-failure-telemetry.md))
caught one failure in a WiFi OTA on t_embed: a 914-byte request with caps
`0x80c` (`MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA | MALLOC_CAP_8BIT`, the WiFi
driver's internal allocator) at an internal low-water mark of 1,528 bytes. On
these S3 boards `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL` is 4096, so an ordinary
`malloc` of 4 KB or less takes internal RAM first and only then PSRAM. Those
mallocs all succeed, and they can still use up the internal RAM that the
allocations which must be internal cannot do without: the WiFi driver's
internal buffers, task stacks, mbedTLS (`CONFIG_MBEDTLS_INTERNAL_MEM_ALLOC`)
and DMA buffers. lwIP's buffers and control blocks are not among them in these
builds: `CONFIG_SPIRAM_TRY_ALLOCATE_WIFI_LWIP` is off, so the shipped S3
`lwipopts.h` maps `mem_clib_malloc` to plain `malloc` (lines 1711-1713), its
`MEMP_MEM_MALLOC` routes the control-block pools through it, and those small
allocations spill to PSRAM like any other. Its mailboxes, semaphores and
mutexes are FreeRTOS objects (`components/lwip/port/freertos/sys_arch.c`), and
FreeRTOS allocates with `INTERNAL | 8BIT` (`heap_idf.c`), so those are
internal-only.

**What the pool is.** [esp32/src/util/internal_reserve.cpp](esp32/src/util/internal_reserve.cpp)
takes `INTERNAL_RESERVE_BYTES` (16 KB) out of internal RAM at the top of
`setup()` and registers it as a heap of its own with
`heap_caps_add_region_with_caps`. Which requests reach it follows from how
ESP-IDF 5.5.5 walks heaps (`heap_caps_malloc_base`): priority 0, then 1, then
2, and at each priority a heap is tried when it has at least one requested
capability at that priority and every requested capability overall. The pool
has capabilities only at priority 2, and none of them is `MALLOC_CAP_DEFAULT`:
- `malloc` asks for `DEFAULT | INTERNAL`, then `DEFAULT`. The pool lacks
  `DEFAULT`, so it never serves either.
- The WiFi driver's `0x80c` request meets internal RAM at priority 0 and
  pure-DRAM at priority 1 first, and reaches the pool at priority 2 only
  when both refuse.
- An added heap goes to the head of the heap list, so at priority 2 the pool
  comes before RTC RAM and PSRAM. A request naming only `8BIT` or `32BIT`
  can therefore land in it, the same as with ESP-IDF's own reserve. So does
  an internal request without DMA, such as a task stack or another FreeRTOS
  object (`INTERNAL | 8BIT`) or an mbedTLS buffer: it reaches the pool after
  internal DRAM and before the 8 KB of RTC fast RAM, which also answers only
  at priority 2. RTC RAM cannot serve DMA, so for a DMA request, the WiFi
  driver's included, the pool is the last heap tried. RTC RAM may be gone by
  then anyway, since `malloc`'s internal-first attempt can use it too.

`MALLOC_CAP_PID2` rides along as a marker. ESP-IDF does not use PIDs, so it
changes nothing about which requests the pool serves, and it lets
`heap_caps_get_free_size` read the pool alone. A `static_assert` keeps
`MALLOC_CAP_DEFAULT` and `MALLOC_CAP_SPIRAM` out of the whole mask, marker
included. The carve asks for `MALLOC_CAP_DEFAULT` too, so a second pass of the
loop cannot take a block out of the pool it has just registered.

**Which boards.** Only t_embed, the board it was measured on
(`AGENTDECK_INTERNAL_RESERVE` in `esp32/src/config.h`). The first version of
this change enabled it on every PSRAM board except IPS10 on the strength of
that one run. Review pointed to the parked internal low-water marks the
allocation-counter run had recorded: 21–28 KB on ips_35, 19–22 KB on t_embed
and 13 KB on the 86 Box. On the 86 Box a 16 KB carve is more than the parked
headroom. The regular internal heap would sit at 0 while parked, and long-lived
internal or DMA allocations made after `setup()` (the WiFi driver's static RX
buffers, task stacks, I2S and LVGL DMA buffers) could settle in the pool for
good, leaving nothing for the OTA it exists for. ips_35, amoled and the e-ink
panels have not been measured with it. Boards without PSRAM would only lose RAM
to it, and IPS10's WiFi runs on a hosted coprocessor. The code is compiled only
where `config.h` asks for it and the build flags define `BOARD_HAS_PSRAM`, not
on `CONFIG_SPIRAM` alone: the classic ESP32 libraries set `CONFIG_SPIRAM` for
TTGO too, which has no PSRAM and about 1 KB of static DRAM left.

**The heap figures leave the pool out.** The pool carries `INTERNAL` and `DMA`,
so every plain `heap_caps_*` query for either counts it. Left that way,
`freeHeapKb`, `minFreeHeapKb` and `largestFreeBlockKb`, the `[HeapFail]` line
and `logHeap` would have changed meaning against the allocation-counter
baseline. In the run measured below, the regular internal heap fell under 1 KB
during bring-up while `minFreeHeapKb` read 14, which beside that baseline's 0,
1 and 3 KB reads as fixed. `largestFreeBlockKb` could never drop below the idle
pool's 15 KB block. So the board reads its internal heap through three helpers
in `internal_reserve.h`. `heapFreeBytes` and `heapMinFreeBytes` subtract the
pool's own free and minimum in bytes, before anything is divided into KB, and
the minimum comes out exact because `heap_caps_get_minimum_free_size` sums
per-heap minima. `heapLargestFreeBlock` adds `MALLOC_CAP_DEFAULT` to the query:
every regular S3 heap these queries match carries it (DIRAM, DRAM and RTC RAM,
`components/heap/port/esp32s3/memory_layout.c`), and the pool does not. On a
board without a pool the three are the plain queries.

**What the board reports about the pool.** A heap added after startup gets its
minimum reset to 0 (`heap_caps_add_region_with_caps` calls
`multi_heap_restore_minimum_free_bytes(heap, 0)`), and
`heap_caps_get_minimum_free_size` says it leaves such heaps out. So `begin()`
calls `heap_caps_monitor_local_minimum_free_size_start()`, which resets every
heap's minimum to its current free size. That call cannot fail softly: it
asserts when it cannot allocate its bookkeeping and otherwise returns `ESP_OK`
(`heap_caps.c`), so there is no untracked state to report. It is never
stopped, because stopping restores the saved value, and for the pool that is
the 0. One consequence: on a board with a pool, `minFreeHeapKb` is the minimum
since `setup()` rather than since boot.

`device_info` carries three fields by one rule. `internalReserveKb` is absent
when the firmware asks for no pool. It is 0 when the firmware asked and none
could be carved, which happens with no PSRAM at boot: the OPI module variants
set `CONFIG_SPIRAM_IGNORE_NOTFOUND`, so a board can come up without it.
Otherwise it is the pool's size, and `internalReserveFreeKb` and
`internalReserveMinKb` come with it. The free figure is there because a
low-water mark alone cannot say whether the pool is in use now. An OTA ends in
a restart that takes both counters with it, so `handleOtaEnd` prints
`[Reserve] at=ota-end capacity=… free=… min=… allocFailures=…` first, and a
failed allocation prints `[Reserve] at=heap-fail …` beside its `[HeapFail]`
line. The Node daemon logs both under `esp32-heap`.

**Rejected.**
- `CONFIG_SPIRAM_MALLOC_RESERVE_INTERNAL`. It is 0 in the prebuilt Arduino
  libraries, and changing it means rebuilding the framework from source in
  every environment (`custom_sdkconfig`). It would not have helped anyway:
  ESP-IDF 5.5.5 registers its reserve with
  `{0, DMA | INTERNAL, DEFAULT | 8BIT | 32BIT}`
  (`components/esp_psram/system_layer/esp_psram.c`). The `INTERNAL` bit at
  priority 1 lets `malloc`'s first attempt in, so the same churn drains it.
- `heap_caps_malloc_extmem_enable(0)` for the length of an OTA, sending every
  `malloc` to PSRAM first. It changes where all allocations go mid-flight,
  including buffers some code may hand to DMA, and it covers only the OTA,
  not other WiFi load.
- A balloon block allocated at boot and freed when an OTA begins. The freed
  block goes back to the general heap, where `malloc`'s internal-first
  attempts take it just as fast. It delays the problem without fixing it.
- The pool on every PSRAM board from the one t_embed run, as this change first
  shipped it. See **Which boards**.
- Leaving the heap figures pool-inclusive and saying so in `protocol.ts`, as
  this change also first did. The regular heap's minimum could then be
  recovered only as `minFreeHeapKb − internalReserveMinKb`, which is ±1 KB
  because both are truncated, and every comparison with the earlier readings
  would need that arithmetic.

**Measured.** t_embed (ESP32-S3, RSSI −54 dBm) took one WiFi OTA of its own
image (`e929da2b`: 3,890 chunks of 1 KB in 231 s) while a passive observer
read its serial port. These readings come from the first version of this
change, whose heap figures still counted the pool:
- At boot: `capacity=15956 regions=1 requested=16384 tracked=1` (a `tracked`
  field since dropped, see above). That is one 16 KB region, 428 B of which is
  heap bookkeeping.
- WiFi bring-up set both low-water marks within 15 s of boot:
  `minFreeHeapKb` 14 and `internalReserveMinKb` 14. Each is a sum of per-heap
  minima, which need not have been reached at the same instant. The regular
  heaps' minima summed to at most 771 B (`minFreeHeapKb` under 15 KB, less the
  pool's 14,588 B), so at some point in bring-up the regular internal heap was
  all but empty, and requests reached the pool, which they do only once
  internal DRAM has refused them.
- From then until the reboot, the whole OTA included, every 30-second
  `device_info` read 21 KB of internal RAM free, 5–6 KB of it outside the
  pool, and neither low-water mark moved. At the end:
  `free=15956 min=14588 allocFailures=0`. The pool was whole again, so
  nothing had settled in it.
- The run before the pool, on the same board with `2dac4169-dirty`, moved
  3,889 chunks in 154 s, took internal RAM down to 1,528 B during the OTA,
  and had one failure: 914 B with caps `0x80c` at 82 %.

This is consistent with the mechanism: with 16 KB out of `malloc`'s reach, the
small allocations on the OTA path find the regular internal heap nearly full
and go to PSRAM, so they no longer eat what the WiFi driver needs. It is one
run on each side, though. The two differ in image, duration (231 s against
154 s) and radio conditions, and the pool's low-water mark was set at bring-up
and did not move during the OTA. So it is not a failure rate, and it does not
show that the OTA leaned on the pool.

**Fleet build.** On the final tree every firmware environment built, one at a
time with led8x32 last: ttgo, t_embed, t_display_pro, esp32_c6_147, ips10,
ips35, box_86, amoled, trmnl_75, nm_epd_420, lilygo_epd47 and led8x32. TTGO
links with 1,016 B of static DRAM left, the same as master, since the pool's
code is not compiled there. IPS10's `firmware.bin` is 6,235,104 B, 99.1 % of
its 6 MB app slot, with 55 KB left. PlatformIO's own Flash figure for it reads
98.0 %, because it leaves out `.eh_frame` (67,056 B there). The slot was nearly
full before this branch, and the next IPS10 feature will run into it. All 14
`esp32/sim` environments build. The host simulator compiles `logHeap`, so it
defines the two helpers `logHeap` calls, answering with its heap shim's
figures.

**Left open.**
- Every other board. Measure a board's parked internal low-water mark and a
  WiFi OTA with the pool before adding it to `config.h`. The 86 Box cannot
  take 16 KB as it is.
- The Swift daemon does not parse the heap fields. The `internalReserve*`
  fields reach `/devices` and the `esp32-heap` log only through the Node
  daemon.
- 16 KB is a starting size. The one measured run drew 1.4 KB of it, during
  WiFi bring-up rather than the OTA. Size it from more drawdowns before tuning
  it either way.
- Library code still counts the pool. arduinoWebSockets 2.7.3 packs a frame
  under 1,400 B into one `malloc`'d buffer only when `GET_FREE_HEAP > 6000`
  (`WebSockets.cpp:243`), and it defines `GET_FREE_HEAP` as
  `ESP.getFreeHeap()`, an `INTERNAL` query, without an `#ifndef`, so a build
  flag cannot redirect it. On t_embed the pool's 16 KB keeps that check true
  when the regular internal heap is low, where before the library would have
  sent header and payload as two writes. The buffer is at most 1.4 KB, so it
  goes to PSRAM when internal RAM cannot take it; it is freed after the send;
  and a failed `malloc` falls back to the two writes. The cost is a transient
  small allocation, not a failure. WiFiManager shows `ESP.getFreeHeap()` on
  its info page only. Changing either means patching the library.
