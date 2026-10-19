#pragma once

// Memory discipline helpers for AgentDeck firmware.
//
// Borrowed from crosspoint-reader's lib/Memory/Memory.h. The constraint that
// makes these matter is the no-PSRAM boards (BOARD_TTGO classic ESP32 ~160KB
// heap, BOARD_ESP32_C6_147 single-core no-PSRAM): on those, *fragmentation*
// — not total free heap — is what kills an allocation. The largest free block
// can be far smaller than the reported free heap. See
// .agents/skills/esp32-heap-discipline/SKILL.md for the full rule set.
//
// Kept C++11-compatible. The last gnu++11 environment (`rgb48`, on
// espressif32@6.9.0) was removed when 86 Box consolidated onto `box_86`, so
// every board now builds on the pioarduino toolchain (C++20/23) and this header
// could be modernised. It is left C++11-safe deliberately: `led8x32` is still on
// plain `espressif32`, and the host simulator compiles it too. Avoid
// `enable_if_t`, CTAD deduction guides, and `[[nodiscard]]`.

#include <cstddef>
#include <memory>
#include <new>
#include <type_traits>
#include <utility>

#include <Arduino.h>
#include <esp_heap_caps.h>

#include "internal_reserve.h"

// Nothrow versions of std::make_unique. Return nullptr on allocation failure
// instead of calling abort() (the default for bare `new` when exceptions are
// disabled on ESP32).
//
// Single object:
//   auto obj = makeUniqueNoThrow<Foo>();
//   if (!obj) { Serial.println("[Foo] OOM"); return false; }
//
// Array:
//   auto buf = makeUniqueNoThrow<uint8_t[]>(size);
//   if (!buf) { Serial.println("[buf] OOM"); return false; }
//   someApi(buf.get(), size);
template <typename T, typename... Args>
typename std::enable_if<!std::is_array<T>::value, std::unique_ptr<T>>::type
makeUniqueNoThrow(Args&&... args) {
  return std::unique_ptr<T>(new (std::nothrow) T(std::forward<Args>(args)...));
}

template <typename T>
typename std::enable_if<std::is_array<T>::value && std::extent<T>::value == 0,
                        std::unique_ptr<T>>::type
makeUniqueNoThrow(std::size_t count) {
  typedef typename std::remove_extent<T>::type Elem;
  return std::unique_ptr<T>(new (std::nothrow) Elem[count]());
}

// Calls a cleanup lambda on scope exit (no std::function allocation). Construct
// via makeScopedCleanup so it works without C++17 CTAD:
//   auto f = makeUniqueNoThrow<Thing>();
//   auto cleanup = makeScopedCleanup([&f]{ f->close(); });
template <typename F>
struct ScopedCleanup {
  F fn;
  bool active;
  explicit ScopedCleanup(F f) : fn(std::move(f)), active(true) {}
  ScopedCleanup(ScopedCleanup&& o) : fn(std::move(o.fn)), active(o.active) { o.active = false; }
  ScopedCleanup(const ScopedCleanup&) = delete;
  ScopedCleanup& operator=(const ScopedCleanup&) = delete;
  ScopedCleanup& operator=(ScopedCleanup&&) = delete;
  ~ScopedCleanup() { if (active) fn(); }
};

template <typename F>
ScopedCleanup<F> makeScopedCleanup(F f) {
  return ScopedCleanup<F>(std::move(f));
}

// Log free heap AND largest contiguous free block. The gap between the two is
// the fragmentation signal — a large free heap with a small largest block means
// the next big allocation will fail even though "free heap" looks healthy.
// PSRAM totals are appended only when present. The internal reserve is left
// out (util/internal_reserve.h); its own lines start with "[Reserve]".
inline void logHeap(const char* tag) {
  size_t intFree = InternalReserve::heapFreeBytes(MALLOC_CAP_INTERNAL);
  size_t intBlk = InternalReserve::heapLargestFreeBlock(MALLOC_CAP_INTERNAL);
#if defined(BOARD_TTGO) || defined(BOARD_ESP32_C6_147) || defined(BOARD_LED8X32)
  Serial.printf("[HEAP] %s internal free=%uKB largest=%uKB\n", tag,
                (unsigned)(intFree / 1024), (unsigned)(intBlk / 1024));
#else
  size_t psFree = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
  size_t psBlk = heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM);
  Serial.printf("[HEAP] %s internal free=%uKB largest=%uKB | psram free=%uKB largest=%uKB\n",
                tag, (unsigned)(intFree / 1024), (unsigned)(intBlk / 1024),
                (unsigned)(psFree / 1024), (unsigned)(psBlk / 1024));
#endif
}
