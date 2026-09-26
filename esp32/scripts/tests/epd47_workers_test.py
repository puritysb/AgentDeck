"""Exercise the patched driver's actual draw dispatcher with a fake RTOS.

After init, reject all allocations/task creation: repeated 15-phase draws must
still finish, with fresh parameters and both workers joined before reuse.
"""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
src = (root / '.pio/libdeps/lilygo_epd47/LilyGo-EPD47/src/epd_driver.c').read_text()
start = src.index('void IRAM_ATTR epd_draw_image(')
end = src.index('/******************************************************************************/', start)
draw = src[start:end]
assert 'AGENTDECK_EPD_WORKERS' in src, 'Build lilygo_epd47 first to apply pinned driver patch'
harness = r'''
#include <assert.h>
#include <stdint.h>
#define IRAM_ATTR
#define portMAX_DELAY 0xffffffff
#define pdTRUE 1
typedef int SemaphoreHandle_t;
typedef struct { int x,y,width,height; } Rect_t;
typedef int DrawMode_t;
typedef struct { uint8_t *data_ptr; SemaphoreHandle_t done_smphr; Rect_t area; int32_t frame; DrawMode_t mode; } OutputParams;
static OutputParams fetch_params, feed_params;
static int fetch_worker=1,feed_worker=2,fetch_done=1,feed_done=2;
static int pending[3], phase[3], notices, joins;
static uint8_t image[16];
static void xTaskNotifyGive(int worker) {
    OutputParams p = worker==1 ? fetch_params : feed_params;
    assert(!pending[worker]);
    assert(p.frame==phase[worker]++ % 15);
    assert(p.data_ptr==image && p.area.width==8 && p.mode==7);
    assert(p.done_smphr==worker);
    pending[worker]=1; notices++;
}
static void xSemaphoreTake(int worker, unsigned timeout) {
    assert(timeout==portMAX_DELAY && pending[worker]);
    pending[worker]=0; joins++;
}
// No allocation or task-creation functions are provided: linking fails if the
// real dispatcher reintroduces them after the display has already been erased.
'''
main = '''
int main(void) {
    for (int i=0;i<100;i++) epd_draw_image((Rect_t){0,0,8,4},image,7);
    assert(notices==3000 && joins==3000 && !pending[1] && !pending[2]);
}
'''
with tempfile.TemporaryDirectory() as d:
    c = Path(d)/'test.c'; exe = Path(d)/'test'
    c.write_text(harness+draw+main)
    subprocess.run(['cc','-std=c11','-Werror=implicit-function-declaration',str(c),'-o',str(exe)],check=True)
    subprocess.run([str(exe)],check=True)
print('EPD47: 100 draws / 1500 phases reuse workers with no render allocations')
