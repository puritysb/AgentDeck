#include "internal_reserve.h"

#include <esp_heap_caps.h>

#include "config.h"
#include "heap_telemetry.h"

// The pool is built only into PSRAM environments (the ones whose build flags
// define BOARD_HAS_PSRAM) that config.h asks it of. The classic ESP32
// libraries set CONFIG_SPIRAM even for TTGO, which has no PSRAM, and TTGO's
// static DRAM is about 1 KB from full: no place for dead counters.
#if CONFIG_SPIRAM && defined(BOARD_HAS_PSRAM) && defined(AGENTDECK_INTERNAL_RESERVE)
#define INTERNAL_RESERVE_POOL 1
#include <esp_heap_caps_init.h>
#include <heap_memory_layout.h>
#else
#define INTERNAL_RESERVE_POOL 0
#endif

namespace InternalReserve {

namespace {

#if INTERNAL_RESERVE_POOL
// No allocation asks for this capability (ESP-IDF does not use PIDs), so it
// changes nothing about which requests the pool serves; it only lets the
// heap_caps_get_*_size() queries read the pool apart from the rest of RAM.
constexpr uint32_t POOL_MARKER = MALLOC_CAP_PID2;
constexpr uint32_t POOL_CAPS =
    MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA | MALLOC_CAP_8BIT | MALLOC_CAP_32BIT | POOL_MARKER;
// malloc() asks for DEFAULT, so with it the pool would drain exactly as
// ESP-IDF's own reserve does; SPIRAM would make it a PSRAM heap.
static_assert((POOL_CAPS & (MALLOC_CAP_DEFAULT | MALLOC_CAP_SPIRAM)) == 0,
              "the pool must stay out of malloc()'s reach");
// Where the pool is carved from. DEFAULT is there to exclude the pool itself:
// it has internal DMA RAM too, and a second pass must not carve from it.
constexpr uint32_t CARVE_CAPS = MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA | MALLOC_CAP_DEFAULT;
// A region smaller than this would be mostly heap bookkeeping.
constexpr size_t MIN_REGION_BYTES = 4096;

// Written once by begin(), before any other task exists.
uint32_t capacity = 0;
uint32_t regions = 0;
uint32_t requested = 0;

// Whether a heap_caps query for `caps` counts the pool: a heap matches when it
// has every capability asked for.
bool counted(uint32_t caps) { return capacity > 0 && (POOL_CAPS & caps) == caps; }
#else
constexpr uint32_t capacity = 0;
constexpr uint32_t requested = 0;
#endif

}  // namespace

void begin() {
#if INTERNAL_RESERVE_POOL
    requested = INTERNAL_RESERVE_BYTES;
    if (requested == 0 || !psramFound()) return;

    // The pool may come back as more than one region when internal RAM is
    // already split; each is a block taken from the regular heap for good and
    // registered as a heap of its own, which is how ESP-IDF builds its reserve.
    size_t remaining = requested;
    while (remaining > 0) {
        size_t next = heap_caps_get_largest_free_block(CARVE_CAPS);
        if (next > remaining) next = remaining;
        if (next < MIN_REGION_BYTES) break;
        // Owned by the new heap below for the life of the device; never freed.
        uint8_t* block = static_cast<uint8_t*>(heap_caps_malloc(next, CARVE_CAPS));
        if (!block) break;
        // Lowest priority only: a request reaches this region once internal
        // DRAM has refused it (and, as an added region, before RTC fast RAM;
        // internal_reserve.h says which requests that is).
        const uint32_t caps[SOC_MEMORY_TYPE_NO_PRIOS] = {0, 0, POOL_CAPS};
        if (heap_caps_add_region_with_caps(caps, reinterpret_cast<intptr_t>(block),
                                           reinterpret_cast<intptr_t>(block) + next) != ESP_OK) {
            heap_caps_free(block);
            break;
        }
        regions++;
        remaining -= next;
    }
    capacity = heap_caps_get_free_size(POOL_MARKER);
    if (capacity == 0) return;

    // A heap added after startup reports a minimum of 0 forever, so the pool's
    // low-water mark only exists if minimum tracking restarts from here. This
    // restarts it for every heap: minFreeHeapKb becomes "since setup()" on
    // these boards, which loses nothing that happened after the app began.
    // It cannot fail softly: it asserts when it cannot allocate its
    // bookkeeping, and otherwise returns ESP_OK (heap_caps.c).
    heap_caps_monitor_local_minimum_free_size_start();
#endif
}

uint32_t requestedBytes() { return requested; }

uint32_t capacityBytes() { return capacity; }

uint32_t freeBytes() {
#if INTERNAL_RESERVE_POOL
    if (capacity == 0) return 0;
    return heap_caps_get_free_size(POOL_MARKER);
#else
    return 0;
#endif
}

uint32_t minFreeBytes() {
#if INTERNAL_RESERVE_POOL
    if (capacity == 0) return 0;
    return heap_caps_get_minimum_free_size(POOL_MARKER);
#else
    return 0;
#endif
}

uint32_t heapFreeBytes(uint32_t caps) {
    const size_t all = heap_caps_get_free_size(caps);
#if INTERNAL_RESERVE_POOL
    if (counted(caps)) {
        const size_t pool = freeBytes();
        return all > pool ? all - pool : 0;
    }
#endif
    return all;
}

uint32_t heapMinFreeBytes(uint32_t caps) {
    // Both sides are per-heap minima since begin(), so the difference is the
    // regular heaps' exactly, not an estimate.
    const size_t all = heap_caps_get_minimum_free_size(caps);
#if INTERNAL_RESERVE_POOL
    if (counted(caps)) {
        const size_t pool = minFreeBytes();
        return all > pool ? all - pool : 0;
    }
#endif
    return all;
}

uint32_t heapLargestFreeBlock(uint32_t caps) {
#if INTERNAL_RESERVE_POOL
    // A maximum cannot be subtracted from. On the S3 every regular heap these
    // queries match carries MALLOC_CAP_DEFAULT (DIRAM, DRAM and RTC RAM,
    // components/heap/port/esp32s3/memory_layout.c) and the pool does not, so
    // asking for it as well leaves the pool out, along with IRAM, which
    // serves only 32-bit access.
    if (counted(caps)) caps |= MALLOC_CAP_DEFAULT;
#endif
    return heap_caps_get_largest_free_block(caps);
}

// Formatted on the stack: Print::printf mallocs for lines over 63 bytes.
void logBoot() {
#if INTERNAL_RESERVE_POOL
    if (requested == 0) return;
    char line[128];
    snprintf(line, sizeof(line), "[Reserve] at=boot capacity=%lu regions=%lu requested=%lu",
             (unsigned long)capacity, (unsigned long)regions, (unsigned long)requested);
    Serial.println(line);
#endif
}

void logState(const char* at) {
    if (capacity == 0) return;
    char line[160];
    snprintf(line, sizeof(line), "[Reserve] at=%s capacity=%lu free=%lu min=%lu allocFailures=%lu", at,
             (unsigned long)capacity, (unsigned long)freeBytes(), (unsigned long)minFreeBytes(),
             (unsigned long)HeapTelemetry::failures());
    Serial.println(line);
}

}  // namespace InternalReserve
