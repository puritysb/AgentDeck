#pragma once

#include <Arduino.h>

// A pool of internal RAM that plain malloc() cannot take.
//
// On the PSRAM boards a malloc of 4 KB or less tries internal RAM first
// (CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=4096) and only then PSRAM, so ordinary
// heap churn can drain internal RAM to nothing while every one of those
// mallocs still succeeds. The allocations that can only be internal are the
// ones that then fail: during a WiFi OTA on t_embed one WiFi driver allocation
// (914 B, caps 0x80c) failed with 1,528 B of internal RAM left (devlog
// 2026-10-18-esp32-alloc-failure-telemetry). Those are the pool's clients: the
// WiFi driver's internal buffers, task stacks and other FreeRTOS objects, DMA
// buffers and other explicit MALLOC_CAP_INTERNAL requests. lwIP's buffers and
// control blocks are not among them in these builds: it allocates those with
// plain malloc (CONFIG_SPIRAM_TRY_ALLOCATE_WIFI_LWIP is off), which spills to
// PSRAM like any other small malloc. Its mailboxes and semaphores are FreeRTOS
// objects, though, and can reach the pool.
//
// ESP-IDF's own reserve, CONFIG_SPIRAM_MALLOC_RESERVE_INTERNAL, is 0 in the
// prebuilt Arduino libraries, and the region its 5.5 implementation registers
// carries MALLOC_CAP_DEFAULT, which lets malloc()'s internal-first attempt in.
// This pool carries no DEFAULT bit, so malloc() never looks there, and it
// answers only at the lowest priority, so a request reaches it only once
// internal DRAM has refused. A region added at run time goes to the head of
// the heap list, so at that priority the pool comes before RTC fast RAM: an
// internal request without DMA (a task stack, a FreeRTOS queue) tries the pool
// first, while a DMA request, which RTC RAM cannot serve, has nowhere left
// after it. (A request naming only 8BIT or 32BIT can reach it too, as it can
// reach ESP-IDF's reserve; malloc() cannot.) It is built only for the boards
// config.h names (AGENTDECK_INTERNAL_RESERVE); everywhere else these functions
// report no pool and the plain heap figures.
namespace InternalReserve {

// Carves INTERNAL_RESERVE_BYTES (config.h) out of internal RAM. Call once, at
// the top of setup(), while internal RAM is still one large free block.
void begin();

// What this firmware asked for: 0 on a board that asks for no pool.
uint32_t requestedBytes();
// Usable bytes in the pool right after begin(); 0 when nothing was carved
// (no pool asked for, or no PSRAM found at boot).
uint32_t capacityBytes();
uint32_t freeBytes();
// The pool's low-water mark since begin().
uint32_t minFreeBytes();

// The internal heap with the pool left out: the figures the board reported
// before the pool existed (device_info's freeHeapKb, minFreeHeapKb and
// largestFreeBlockKb, the [HeapFail] line, logHeap). The pool carries
// INTERNAL and DMA, so a plain heap_caps query for either counts it, and its
// untouched 16 KB would read as headroom the regular heap does not have.
// Library code still counts it: arduinoWebSockets reads ESP.getFreeHeap()
// before packing a frame (the 2026-10-18 internal-reserve devlog).
uint32_t heapFreeBytes(uint32_t caps);
uint32_t heapMinFreeBytes(uint32_t caps);
uint32_t heapLargestFreeBlock(uint32_t caps);

// Numeric "[Reserve] at=…" lines, the format the daemon logs under
// esp32-heap. logBoot() exists because begin() runs before Serial is up;
// logState() is for the moments the pool matters: just before an OTA reboot
// takes the low-water mark and the failure count with it, and right after an
// allocation failed.
void logBoot();
void logState(const char* at);

}  // namespace InternalReserve
