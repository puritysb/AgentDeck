#pragma once

#include <cstdint>
#include "../../state/agent_state.h"

namespace Crayfish {

void init();

/**
 * Render the crayfish creature.
 * @param state DORMANT/SITTING/ROUTING/SICK
 */
void render(uint16_t* buf, int w, int h, float time, CrayfishState state, bool needsInput = false);
float getX();
float getY();

}  // namespace Crayfish
