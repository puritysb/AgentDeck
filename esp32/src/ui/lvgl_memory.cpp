#include "config.h"
#if defined(BOARD_IPS10) && !defined(SIM_HOST)
#include <lvgl.h>
#include <esp_heap_caps.h>
#include <cstring>

// LVGL owns and frees these variable-sized objects/styles/caches. The full
// workspace consumed the ~86 KiB internal heap left after display/audio init;
// allocate its metadata in the 32 MiB PSRAM pool instead. Draw and rotation
// buffers still use explicit internal-DMA allocations in display.cpp.
// No internal fallback: a UI allocation must never consume the network reserve.
extern "C" {
void lv_mem_init(void) {}
void lv_mem_deinit(void) {}
lv_mem_pool_t lv_mem_add_pool(void*, size_t) { return nullptr; }
void lv_mem_remove_pool(lv_mem_pool_t) {}
void* lv_malloc_core(size_t size) {
    return heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
}
void* lv_realloc_core(void* ptr, size_t size) {
    return heap_caps_realloc(ptr, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
}
void lv_free_core(void* ptr) { heap_caps_free(ptr); }
void lv_mem_monitor_core(lv_mem_monitor_t* mon) {
    memset(mon, 0, sizeof(*mon));
    mon->total_size = heap_caps_get_total_size(MALLOC_CAP_SPIRAM);
    mon->free_size = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    mon->free_biggest_size = heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM);
}
lv_result_t lv_mem_test_core(void) {
    return heap_caps_check_integrity(MALLOC_CAP_SPIRAM, false) ? LV_RESULT_OK : LV_RESULT_INVALID;
}
}
#endif
