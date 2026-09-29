#pragma once
// AgentDeck ESP32 host simulator — public interfaces for the sim driver.
//
// The simulator compiles the *real* firmware LVGL render surface (currently the
// terrarium) against a host toolchain, renders board-accurate frames into an
// in-memory RGB565 framebuffer via a headless LVGL display, and dumps PNGs.
// Because it reuses the firmware sources verbatim (same board defines, same
// pixel math), the output is pixel-exact — not an approximation.
#include <cstdint>
#include <cstddef>

// Match LVGL's own forward declaration verbatim so this stays a compatible
// (identical) typedef when <lvgl.h> is also included in the same translation unit.
struct _lv_obj_t;
typedef struct _lv_obj_t lv_obj_t;

namespace SimDisplay {
// Create a headless LVGL display of w×h in RGB565 with a framebuffer flush.
void init(int w, int h);
// Active LVGL screen — pass to Terrarium::init as the render parent.
lv_obj_t* screen();
// Load a screen object (from Screens::aquariumCreate) as the active screen.
void loadScreen(lv_obj_t* scr);
// Advance the virtual clock and LVGL tick by `ms` (drives animation phase).
void tick(uint32_t ms);
// Composite + flush the current LVGL tree into the framebuffer synchronously.
void refresh();
// Final RGB565 framebuffer (w*h uint16_t, row-major, non-swapped).
const uint16_t* framebuffer();
int width();
int height();
}  // namespace SimDisplay

namespace SimPng {
// Encode an RGB565 framebuffer to a PNG file. Self-contained (no libpng/zlib):
// stored DEFLATE blocks + CRC32/Adler32. Returns true on success.
bool writeRgb565(const char* path, const uint16_t* fb, int w, int h);
}  // namespace SimPng

namespace SimMatrix {
// Render a TC001 8×32 page ("usage" | "agents") after `frames` animation steps,
// upscaled ×scale, to a PNG. Only defined for the BOARD_LED8X32 env.
bool renderToPng(const char* scene, const char* page, int frames, int scale, const char* path);
}  // namespace SimMatrix

namespace SimEink {
// Render the TRMNL 7.5" 800×480 1-bit e-ink dashboard for a scene to PNG. Only
// defined for the BOARD_TRMNL_75 env.
bool renderToPng(const char* scene, const char* path);
}  // namespace SimEink

namespace SimScenes {
// Populate g_state for a named scene ("idle", "working", "multi", "permission",
// "empty"). Returns false for an unknown name.
bool apply(const char* name);
// Comma-separated catalog of scene names for --help / --list.
const char* catalog();
}  // namespace SimScenes

namespace SimCommands {
void reset();
unsigned count();
const char* last();
}
