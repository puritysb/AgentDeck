#pragma once

#include <lvgl.h>

namespace Terrarium {

/**
 * Initialize terrarium canvas and static elements.
 * @param parent LVGL parent object (screen)
 */
void init(lv_obj_t* parent);

/**
 * Render one frame of the terrarium animation.
 * Called at ~30fps from LVGL timer.
 * @param dt Delta time in seconds since last frame
 */
void render(float dt);

/**
 * Get the canvas object for screen management.
 */
lv_obj_t* getCanvas();
// Keep a visible body clear of actual HUD panels, the shell mouth and peers.
void placeResident(float& x, float& y, float halfWidth, float halfHeight, bool active, float previousX=-1, float previousY=-1, bool enteringHome=false);
struct LayoutDiagnostics { unsigned residents, collisions; float shellOpening; bool shellBodiesVisible; };
LayoutDiagnostics layoutDiagnostics();
float residentScale();
float sharedHomeX();
float sharedHomeY();
bool showResidentName(bool active);

}  // namespace Terrarium
