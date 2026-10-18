---
name: esp32-heap-discipline
description: Memory-allocation discipline for AgentDeck ESP32 firmware (esp32/). Use whenever writing or reviewing firmware code that allocates — new / malloc / ps_malloc / heap_caps_alloc / std::vector / std::string / String / a buffer / a cache / anything held across a render loop. Covers the PSRAM-vs-no-PSRAM board split, the allocation decision order, fragmentation avoidance, the makeUniqueNoThrow / ScopedCleanup helpers, the PROTOCOL_MAX_MSG_BYTES JSON guard, and the heap diagnostics (logHeap / [PERF] freeblk / allocFailures and [HeapFail]).
---

# ESP32 Heap Discipline

Memory rules for `esp32/` firmware. Adapted from crosspoint-reader's
`heap-discipline` skill to AgentDeck's multi-board reality. This is the
procedure you run while writing firmware and the gate before handing it back.

## The board split — know which world you're in

AgentDeck firmware targets two memory regimes. Check the board macros first.

- **PSRAM boards** — `BOARD_BOX_86`, `BOARD_IPS35`, `BOARD_AMOLED`, `BOARD_IPS10`
  (ESP32-S3 / -P4, 8–32MB PSRAM). Large canvases/caches go in PSRAM
  (`ps_malloc` / `MALLOC_CAP_SPIRAM`). **But** per-pixel / LVGL draw buffers and
  PPA rotation buffers must stay in **internal SRAM** (`MALLOC_CAP_INTERNAL`):
  PSRAM writes are ~30× slower, so a PSRAM draw buffer makes every widget render
  crawl (see the IPS10 rationale in `esp32/src/ui/display.cpp`). Plenty of total
  RAM here; the constraint is *write latency and internal-SRAM headroom*, not
  bytes.
- **No-PSRAM boards** — `BOARD_TTGO` (classic ESP32, ~160KB heap),
  `BOARD_ESP32_C6_147` (single-core RISC-V), `BOARD_LED8X32` (TC001). This is
  crosspoint's world: every allocation matters and **fragmentation, not total
  usage, is what kills the device.** Free heap can read fine while the largest
  free block is too small for the next alloc. Optimize for not leaving holes.

The canvas/buffer code already encodes this split (`renderer.cpp::init` uses
static pre-allocated buffers on TTGO/C6 and `ps_malloc`+SRAM fallback
elsewhere). Match the existing pattern; don't invent a third path.

## Allocation decision procedure

Ask in order; stop at the first yes.

1. **Stack?** Local, bounded, under ~256 bytes: plain array/struct. The task
   stacks are sized per board in `config.h` (`STACK_UI`) — keep frames lean.
2. **Compile-time constant?** `static constexpr` lives in flash, costs zero
   DRAM. Lookup tables and string literals belong here.
3. **Allocated once and reused for the screen/activity lifetime?** Allocate at
   init, hold in a static/member, reuse every frame. Never per-frame, never
   per-iteration, never in the render/flush path.
4. **Dynamic and fallible?** `makeUniqueNoThrow<T>(...)` /
   `makeUniqueNoThrow<T[]>(n)` from `esp32/src/util/memory.h`. Null-check, log,
   return. It frees on every exit path. Use `makeScopedCleanup([&]{ … })` for
   non-owning teardown (the header is kept C++11-safe — `led8x32` builds at
   gnu++11 — so construct the guard via the factory, not C++17 CTAD).
5. **A C/SDK API takes ownership / the object lives for the device lifetime?**
   Only then raw `new` / `heap_caps_alloc` / `ps_malloc`, with a null-check +
   `Serial.printf` error and a comment naming who owns it. The display driver
   objects in `display.cpp` are this case (one-time, device-lifetime).

Bare `new`/`new[]` whose result you don't null-check is never acceptable: with
exceptions disabled it `abort()`s on OOM; even with them on, an unchecked deref
crashes. (We had a one-time `new (uint8_t[]){…}` leak in `jd9365_lcd.cpp` —
fixed to a stack local.)

## Fragmentation rules (no-PSRAM boards especially)

- `std::vector`: `reserve(n)` before any `push_back` loop. Each growth is
  alloc-copy-free — three heap ops that leave a hole. Unknown n: estimate high.
- No repeated `new`/`delete` or growing containers inside a loop or the render
  path. Hoist the allocation out.
- `std::string` / Arduino `String`: acceptable on cold paths (setup, file I/O).
  Banned on the render path. Build text with a stack `char[]` + `snprintf`; the
  state struct (`agent_state.h`) already uses fixed `char[]` fields — match it.
- Bound untrusted input. Inbound bridge frames are capped by
  `PROTOCOL_MAX_MSG_BYTES` (`config.h`) and dropped in `Protocol::parseMessage`
  before they reach the elastic ArduinoJson `JsonDocument`. Keep that guard; if
  you add a new growable parse path, bound it the same way.

## Diagnostics — measure the right thing

- `logHeap(const char* tag)` (`esp32/src/util/memory.h`) prints free heap **and**
  largest free block (plus PSRAM totals on PSRAM boards). The gap between the two
  is the fragmentation signal. It's already called at `boot`, `post-terrarium`,
  and on a 30s `tick` on no-PSRAM boards. Add a call after any new large
  allocation rather than guessing.
- The IPS10 `[PERF]` profiler line (`main.cpp`, `IPS10_PERF_PROFILE`) now carries
  a `freeblk` field — a shrinking freeblk while fps holds steady is the
  fragmentation tell.
- **A low-water mark of 0 is not a failed allocation.** On the PSRAM boards an
  ordinary `malloc` that misses internal RAM retries in PSRAM, so
  `minFreeHeapKb` can read 0 while every request succeeded. What did fail is
  counted by `util/heap_telemetry.h` (ESP-IDF's failed-allocation hook, which
  fires only after the last fallback): `allocFailures` /
  `allocFailLastBytes` / `allocFailLastCaps` in `device_info`, and a numeric
  `[HeapFail]` serial line that the daemon logs under `esp32-heap`. On a
  serial-attached board `device_info` is a connect-time snapshot, so read the
  line. A deliberate attempt with a fallback (internal buffer, then PSRAM)
  counts too, so judge a count by its size and caps.

## Justify every allocation

When you add a heap allocation, state in one line why stack/static/reuse was
rejected and the worst-case size. If you can't name the size, you can't budget
it, and shouldn't allocate it. Cite the board regime you're allocating for.

## Self-review before handoff

- [ ] Identified the board regime (PSRAM vs no-PSRAM) and allocated accordingly.
- [ ] No bare `new`/`new[]` without a null-check + log; fallible allocs use
      `makeUniqueNoThrow`, raw allocs carry an owner comment.
- [ ] No allocation inside a loop / render / flush path that could be hoisted.
- [ ] Every `push_back` loop has a preceding `reserve`.
- [ ] Per-pixel/LVGL draw buffers stay `MALLOC_CAP_INTERNAL` on PSRAM boards.
- [ ] Any new growable parse/ingest path is bounded (cf. `PROTOCOL_MAX_MSG_BYTES`).
- [ ] Added a `logHeap` call near any new large allocation; checked freeblk, not
      just free heap.
- [ ] Each new allocation carries a one-line size + why-not-stack/static note.
