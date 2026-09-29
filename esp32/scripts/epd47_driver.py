"""Patch pinned LilyGo driver to reserve render workers before clearing glass.

The upstream driver allocates two 8 KiB tasks for EACH grayscale phase, ignores
creation failure, then waits forever for both. Under fragmented internal RAM,
the panel is cleared white but the first image never completes. Keep device-
lifetime workers and semaphores; there are no render-path task allocations.
"""
from pathlib import Path


def patch(source):
    if 'AGENTDECK_EPD_WORKERS' in source:
        return source

    def replace(old, new, count=1):
        nonlocal source
        if source.count(old) != count:
            raise RuntimeError('Pinned EPD47 driver changed: ' + old[:80])
        source = source.replace(old, new)

    replace('static QueueHandle_t output_queue;', '''static QueueHandle_t output_queue;
// AGENTDECK_EPD_WORKERS: device-lifetime tasks, one non-reentrant draw owner.
// Preserve internal stacks and DMA buffers. Only the 64 KiB lookup table moves
// to PSRAM; it is read by CPU, never DMA, and cannot fit on a task stack.
static TaskHandle_t fetch_worker, feed_worker;
static SemaphoreHandle_t fetch_done, feed_done;
static OutputParams fetch_params, feed_params;
static void fetch_loop(void *unused) {
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        provide_out(&fetch_params);
    }
}
static void feed_loop(void *unused) {
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        feed_display(&feed_params);
    }
}''')
    replace('heap_caps_malloc(1 << 16, MALLOC_CAP_8BIT)',
            'heap_caps_malloc(1 << 16, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)')
    replace('output_queue = xQueueCreate(64, EPD_WIDTH / 2);', '''output_queue = xQueueCreate(64, EPD_WIDTH / 2);
    fetch_done = xSemaphoreCreateBinary();
    feed_done = xSemaphoreCreateBinary();
    if (!output_queue || !fetch_done || !feed_done) {
        ESP_LOGE("epd", "Cannot reserve render synchronization");
        abort(); // fail before panel power-on/erase, never wait for a missing task
    }
    if (xTaskCreatePinnedToCore(fetch_loop, "epd-fetch", 8192, NULL, 10,
                                &fetch_worker, 0) != pdPASS ||
        xTaskCreatePinnedToCore(feed_loop, "epd-feed", 8192, NULL, 10,
                                &feed_worker, 1) != pdPASS) {
        ESP_LOGE("epd", "Cannot reserve render workers");
        abort();
    }''')
    begin = source.index('    SemaphoreHandle_t fetch_sem =', source.index('void IRAM_ATTR epd_draw_image('))
    end = source.index('    vSemaphoreDelete(feed_sem);', begin) + len('    vSemaphoreDelete(feed_sem);')
    source = source[:begin] + '''    for (uint8_t k = 0; k < frame_count; k++) {
        fetch_params = (OutputParams){ .area = area, .data_ptr = data,
            .frame = k, .mode = mode, .done_smphr = fetch_done };
        feed_params = fetch_params;
        feed_params.done_smphr = feed_done;
        xTaskNotifyGive(fetch_worker);
        xTaskNotifyGive(feed_worker);
        xSemaphoreTake(fetch_done, portMAX_DELAY);
        xSemaphoreTake(feed_done, portMAX_DELAY);
    }
''' + source[end:]
    replace('    vTaskDelay(portMAX_DELAY);', '', 2)
    return source


if __name__ == '__main__':
    import sys
    path = Path(sys.argv[1])
    path.write_text(patch(path.read_text()))
else:
    Import('env')
    driver = Path(env.subst('$PROJECT_LIBDEPS_DIR')) / env['PIOENV'] / 'LilyGo-EPD47/src/epd_driver.c'
    if not driver.is_file():
        raise RuntimeError('Install pinned EPD47 dependencies with pio pkg install before building')
    original = driver.read_text()
    updated = patch(original)
    if updated != original:
        driver.write_text(updated)
        print('[epd47] Reserved persistent render workers; lookup table in PSRAM')
