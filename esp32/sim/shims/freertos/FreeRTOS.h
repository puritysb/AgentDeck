#pragma once
// Host shim for <freertos/FreeRTOS.h>. The terrarium render surface never takes
// the state mutex itself — it only needs the SemaphoreHandle_t type so that
// state/agent_state.h (which declares `extern SemaphoreHandle_t g_stateMutex`)
// parses on the host toolchain.
#include <cstdint>

typedef void*    SemaphoreHandle_t;
typedef uint32_t TickType_t;
typedef int      BaseType_t;

#define pdTRUE          1
#define pdFALSE         0
#define portMAX_DELAY   0xFFFFFFFFu
#define pdMS_TO_TICKS(ms) ((TickType_t)(ms))

// ── Spinlock / core identity ────────────────────────────────────────────────
// Render surfaces that are written from the network core and drawn on the UI
// core guard their hand-off with an ESP-IDF spinlock (IPS10's voice banner is
// the first). The sim runs those sources single-threaded on one host thread, so
// the critical section is a no-op — but the types and macros still have to
// exist or the board's render surface will not compile here. Keeping them in
// the shim (rather than #if SIM_HOST in the firmware) leaves the firmware
// source the sim compiles identical to what the board flashes.
typedef struct { volatile uint32_t owner; } portMUX_TYPE;

#define portMUX_INITIALIZER_UNLOCKED { 0 }
#define portENTER_CRITICAL(mux)      ((void)(mux))
#define portEXIT_CRITICAL(mux)       ((void)(mux))
#define portENTER_CRITICAL_ISR(mux)  ((void)(mux))
#define portEXIT_CRITICAL_ISR(mux)   ((void)(mux))

static inline BaseType_t xPortGetCoreID() { return 0; }
