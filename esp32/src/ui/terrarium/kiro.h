#pragma once

#include <cstdint>
#include "../../state/agent_state.h"

namespace Kiro {

void init();

void render(uint16_t* buf, int w, int h, float time, float dt,
            CreatureState state, uint8_t idx, uint8_t total);

float getX(uint8_t idx);
float getY(uint8_t idx);

}  // namespace Kiro
