#include "heap_telemetry.h"

#include <esp_attr.h>
#include <esp_heap_caps.h>

#include "internal_reserve.h"

namespace HeapTelemetry {

namespace {

// The hook runs inside whichever allocation failed, which can be on either
// core and with the flash cache disabled, so it lives in IRAM and touches only
// these DRAM words.
uint32_t failureCount = 0;
uint32_t lastBytes = 0;
uint32_t lastCaps = 0;

void IRAM_ATTR onAllocFailed(size_t size, uint32_t caps, const char* /*function*/) {
    __atomic_store_n(&lastBytes, (uint32_t)size, __ATOMIC_RELAXED);
    __atomic_store_n(&lastCaps, caps, __ATOMIC_RELAXED);
    __atomic_add_fetch(&failureCount, 1u, __ATOMIC_RELEASE);
}

}  // namespace

void begin() { heap_caps_register_failed_alloc_callback(onAllocFailed); }

uint32_t failures() { return __atomic_load_n(&failureCount, __ATOMIC_ACQUIRE); }
uint32_t lastFailedBytes() { return __atomic_load_n(&lastBytes, __ATOMIC_RELAXED); }
uint32_t lastFailedCaps() { return __atomic_load_n(&lastCaps, __ATOMIC_RELAXED); }

void logIfChanged() {
    static uint32_t logged = 0;
    static uint32_t lastLogMs = 0;
    const uint32_t count = failures();
    if (count == logged) return;
    const uint32_t now = millis();
    if (lastLogMs != 0 && now - lastLogMs < 2000) return;
    lastLogMs = now;
    logged = count;
    // Formatted on the stack: Print::printf mallocs for lines over 63 bytes,
    // and this line is written when the heap has just refused someone.
    char line[160];
    snprintf(line, sizeof(line),
             "[HeapFail] count=%lu lastBytes=%lu lastCaps=0x%lx internalFree=%lu internalMin=%lu internalLargest=%lu",
             (unsigned long)count, (unsigned long)lastFailedBytes(), (unsigned long)lastFailedCaps(),
             (unsigned long)InternalReserve::heapFreeBytes(MALLOC_CAP_INTERNAL),
             (unsigned long)InternalReserve::heapMinFreeBytes(MALLOC_CAP_INTERNAL),
             (unsigned long)InternalReserve::heapLargestFreeBlock(MALLOC_CAP_INTERNAL));
    Serial.println(line);
    // The internal figures above leave the pool out; this is its side of the
    // same moment, on a board that has one.
    InternalReserve::logState("heap-fail");
}

}  // namespace HeapTelemetry
