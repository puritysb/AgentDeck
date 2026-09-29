#pragma once

#include <FastLED.h>
#include "matrix_display.h"

namespace MatrixPages {

void renderUsage(CRGB* leds, float animTime);
void renderCodex(CRGB* leds, float animTime);
void renderZai(CRGB* leds, float animTime);
void renderAgents(CRGB* leds, float animTime);

} // namespace MatrixPages
