# 2026-10-18 — ESP32: a heap at 0 KB is not a failed allocation, so count the failures

**Why.** During the 1.9.2 fleet refresh, `device_info` reported internal-heap
low-water marks of 0 KB on ips_35, 1 KB on t_embed and 3 KB on the 86 Box, all
after WiFi bring-ups. That number cannot say whether anything failed. On these
S3 boards `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL` is 4096: a plain `malloc` of
4 KB or less tries internal RAM first, and when that misses, ESP-IDF 5.5.5's
`heap_caps_malloc_default` retries in PSRAM. Allocations that all succeeded can
drain the internal pool to zero. What can fail is a request restricted to
internal RAM (WiFi and lwIP make those), and nothing counted them.

**What counts them now.** ESP-IDF calls a registered failed-allocation hook
only once the last attempt has failed: `heap_caps_malloc_default` reports
`MALLOC_CAP_DEFAULT` after both the internal and the PSRAM attempt, and
`heap_caps_malloc` reports the caps it was asked for.
[esp32/src/util/heap_telemetry.cpp](esp32/src/util/heap_telemetry.cpp)
registers one at the top of `setup()`:
- `device_info` always carries `allocFailures`, so 0 means counted and none.
  `allocFailLastBytes` and `allocFailLastCaps` join it after the first failure.
- A numeric `[HeapFail] count=… lastBytes=… lastCaps=0x… internalFree=…
  internalMin=… internalLargest=…` line goes out on serial when the count
  moves, at most every 2 s. The daemon logs it under `esp32-heap`.
- A deliberate attempt that has a fallback counts too (`display.cpp` tries an
  internal DMA buffer before PSRAM), so a count is read with its size and caps.

The hook runs inside the failing allocation, on either core and possibly with
the flash cache off, so it is `IRAM_ATTR` and only stores numbers. Checked in
the built images:
- On the S3 and the classic ESP32 (pioarduino's GCC 14), the increment calls
  ESP-IDF's `__atomic_fetch_add_4`, which is in `.iram0.text` along with
  everything it calls.
- The C6 and P4 builds inline `amoadd.w`, and the TC001's older toolchain
  inlines `s32c1i`.
- Nothing else in the firmware or the prebuilt libraries registers the hook.
  One diagnostics library references the call, and it is not linked.

**device_info could already truncate.** It was serialized into a fixed 896-byte
stack buffer, and ArduinoJson truncates silently. A truncated frame is not
JSON: the daemon drops it and the board stays unidentified. Rebuilt from the
T-Display-S3-Pro's live field values, its frame comes to 832 bytes parked and
867 joined, and 878 after weeks of uptime and touches. The counter alone takes
that last case to 896, which no longer fits with its terminator, and a recorded
failure takes it to 903–949. So `sendDeviceInfoFrame()` measures the document
first and serializes a frame that does not fit into a heap buffer of exactly
that size. The stack buffer still carries the usual frame.

**The instrument, checked.** On the 86 Box, a temporary build answered a
`heap_selftest` command with `heap_caps_malloc(16 MB, MALLOC_CAP_INTERNAL)` and
`malloc(64 MB)`:
- **Before.** `allocFailures: 0`.
- **The command.** `[HeapSelftest] internal16M=0x0 default64M=0x0`, then 0.12 s
  later `[HeapFail] count=2 lastBytes=67108864 lastCaps=0x1000 …`.
- **After.** `device_info` read `allocFailures: 2`,
  `allocFailLastBytes: 67108864`, `allocFailLastCaps: 4096`: the default
  malloc reporting `MALLOC_CAP_DEFAULT` once both attempts had failed, as
  `heap_caps.c` says.
- **Frame size.** 560 bytes with the counter at zero, 615 with a failure
  recorded.

**Measured.** On the three boards whose low-water marks started this, each on
the measurement build:
- **WiFi bring-ups fail nothing.** Six provision cycles per board (join, park,
  ask for `device_info`), ips_35 and t_embed from a fresh boot and the 86 Box
  after 35 minutes up: `allocFailures` stayed 0 and no `[HeapFail]` line
  appeared. The parked low-water marks were 21–28 KB on ips_35, 19–22 KB on
  t_embed and 13 KB on the 86 Box.
- **A WiFi OTA does.** t_embed took its own image over WiFi, 3,889 chunks in
  2 min 34 s, with a read-only observer on its serial port. One allocation
  failed, 82 % of the way through: 914 bytes with caps `0x80c`, which is what
  the WiFi driver's internal allocator asks for
  (`esp_coex_common_malloc_internal_wrapper` is
  `heap_caps_malloc(size, 0x80c)` in the shipped library). The internal
  low-water mark at that moment was 1,528 bytes. The transfer survived it, since
  a dropped frame costs one TCP retransmit. ips_35 took its image the same way,
  2,606 chunks in 5 min 2 s, with no failure.
- **The earlier failures had no counter.** Before these runs, the same two
  transfers failed on the previous build (without #565), on boards up about
  1.7 hours, going through the daemon's serial-hold path. t_embed needed about
  5 s per chunk and died at chunk 64. ips_35 crawled at 1.6 s per chunk on the
  same −71 dBm link until the hold expired. A starved WiFi driver fits both,
  but three things differ from the runs above and none of them was measured.
- **Where the internal RAM goes.** ips_35 boots with 238 KB of internal heap
  and has 35–41 KB left once its UI is up, before WiFi carries anything.
  t_embed goes from 188 KB to 44 KB. These builds also keep every WiFi and lwIP
  buffer in internal RAM (`CONFIG_SPIRAM_TRY_ALLOCATE_WIFI_LWIP` is off) and
  reserve none of it (`CONFIG_SPIRAM_MALLOC_RESERVE_INTERNAL=0`).

For anyone repeating this: opening these native-USB ports from pyserial resets
the board (`USB_UART_CHIP_RESET`), and the daemon's open does not. The first
lines after an open are left over from before it, sometimes a frame with its
middle missing.

**Also fixed.** pioarduino's component manager writes
`esp32/src/idf_component.yml.orig` on the first build and never removes it.
`scripts/git_rev.py` marks a build `-dirty` whenever `git status --porcelain`
prints anything, so every later local build in that checkout reported a dirty
hash over an unmodified tree. The file is ignored now. The measurement builds
above report `2dac4169-dirty` for that reason alone: they are this branch
merged with the mDNS fix (#565), which the test boards already carried.

**Left open.**
- A serial-attached board's `device_info` is a snapshot taken when its
  connection is identified, and the daemon does not ask again. On those boards
  the `[HeapFail]` line is the live signal.
- The Swift daemon surfaces none of the heap fields.
- Whether to free or reserve internal RAM for WiFi before an OTA is the next
  decision, and the counter is how to judge it.
- Getting these builds onto the boards turned up four gaps in WiFi OTA:
  - The CLI's request timeout is a fixed 15 minutes, and the daemon carries on
    after it.
  - The serial hold is a fixed 30 minutes, so a longer transfer is cut off when
    the port reopens.
  - The daemon logs nothing about a transfer's progress or outcome.
  - Nothing stops a second transfer to the same board, and its
    `esp32_ota_begin` aborts the first.
- ips_35 and t_embed send `device_info` through a plain `Serial.println`. One
  of eight replies from ips_35 arrived with a hole (292 of about 563 bytes).
  That is the native-USB block loss `serialWriteJsonLine()` paces around, but
  only on the TRMNL and the T-Display-Pro.
