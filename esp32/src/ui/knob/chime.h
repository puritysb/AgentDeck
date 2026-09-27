#pragma once

// Short I2S speaker chimes for the T-Embed pager mode and the NM-EPD-420 paper
// surface. Playback runs in a
// one-shot FreeRTOS task so the UI loop never blocks on I2S writes.

namespace Chime {

// Two-note rising "needs you" chime — played when a session enters a genuine
// response-wait. Fire-and-forget; overlapping calls are coalesced.
void playAttention();

}  // namespace Chime
