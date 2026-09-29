#pragma once
#include <lvgl.h>

namespace TTGO { namespace Usage {
// UI-task owned. Selection survives rotation, resets to usage on boot.
bool active();
void toggle();
void create(lv_obj_t* parent);
void update();
} }
