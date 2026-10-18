#pragma once

#include <Arduino.h>

// Allocations that came back NULL, counted from setup() on.
//
// device_info's minFreeHeapKb cannot say whether anything failed: on the PSRAM
// boards an ordinary malloc that misses internal RAM is retried in PSRAM, so
// the internal low-water mark can read 0 while every allocation succeeded.
// ESP-IDF calls its failed-allocation hook only once the last attempt has
// failed, and that is the event counted here. It also fires for a deliberate
// attempt that has a fallback (an internal-RAM buffer retried in PSRAM, as
// display.cpp does), so read a count together with the size and capabilities
// of the failure.
namespace HeapTelemetry {

// Registers the hook. ESP-IDF keeps a single hook; nothing else here sets it.
void begin();

uint32_t failures();
// Size and MALLOC_CAP_* mask of the most recent failure; 0 before the first.
uint32_t lastFailedBytes();
uint32_t lastFailedCaps();

// Prints one numeric "[HeapFail]" line when the count has moved, at most every
// two seconds. Runs on the network task: the hook itself only stores numbers.
void logIfChanged();

}  // namespace HeapTelemetry
