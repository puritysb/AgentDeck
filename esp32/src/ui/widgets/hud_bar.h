#pragma once

#include <lvgl.h>
#include "../terrarium/habitat_spacing.h"
// Self-sufficient: the voice API below is gated on board-header capability
// macros, not -D flags, so every includer must see them — and the guard in the
// implementation must agree with the guard here or the definitions vanish while
// the build still links everything else. That failure has now happened twice in
// this tree; the include is the fix, not discipline.
#include "../../../boards/board_config.h"

namespace HUD {

/**
 * Create HUD bar overlay at bottom of screen.
 * @param parent Screen object
 */
void init(lv_obj_t* parent);

/**
 * Update HUD content from current state.
 */
void update();

/**
 * Show/hide HUD bar.
 */
void setVisible(bool visible);
bool isVisible();
// Snapshot actual overlay bounds once per frame; UI task only, no allocations.
size_t habitatObstacles(HabitatSpacing::Rect* out, size_t capacity);

#if defined(BOARD_HAS_VOICE_CAPTURE) || defined(BOARD_HAS_SPEAKER)
/**
 * Voice banners, mirroring the knob UI's contract so the protocol layer can
 * call the same shapes on either board.
 *
 * The listening banner must stay up for the whole hold and name the target
 * session — the operator has to be able to see who they are talking to before
 * they finish talking. The speaking banner exists so a board that is playing a
 * reply is not mistaken for a dead one, and so the reply is legible with the
 * volume down. These entry points are safe from either firmware core: they
 * publish fixed-size state which HUD::update() applies on the LVGL/UI core.
 */
void setListening(const char* target);
void clearListening();
void setSpeaking(const char* text);
void clearSpeaking();
/** Transient one-line status (transcript, delivery failure, mic unavailable). */
void notify(const char* text);
/**
 * Recent Q&A transcript, shown in the banner whenever it is idle. A delivered
 * voice_result pushes the question; the reply's audio_reply_ready fills the
 * answer. Cross-core-safe like the banners above.
 */
void pushVoiceQuestion(const char* q);
void setVoiceAnswer(const char* a);
#endif

}  // namespace HUD
