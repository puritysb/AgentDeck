#pragma once

// T-Display-S3-Pro layout choice: portrait Pocket (222x480) or the landscape
// Focus Strip (480x222). The whole render tree, touch transform and panel
// rotation are chosen once before displayInit(), so a change is persisted to
// NVS and applied by a restart — never by rebuilding screens in place.
//
// AUTO follows the hardware: a camera shield probed at boot selects portrait
// Pocket (the handheld unit), no camera selects the landscape strip. An
// explicit PORTRAIT/LANDSCAPE overrides that until set back to AUTO.
//
// Three ways in, all funnelled through request():
//   - hold either rocker button while the board boots (toggles),
//   - on-screen control (Pocket USAGE tab button / strip Usage page hold),
//   - daemon `set_orientation {layout}` (agentdeck esp32 orientation …).

#include <stdint.h>

namespace StripLayout {

enum Setting : uint8_t { AUTO = 0, PORTRAIT = 1, LANDSCAPE = 2 };

/** Read the persisted setting and resolve the effective layout for this boot. */
void begin(bool cameraPresent);

/** Toggle the persisted setting to the opposite of the effective layout (boot hold). */
void toggleAtBoot(bool cameraPresent);

Setting setting();
/** Effective layout of the running render tree. */
bool portrait();

const char* settingName(Setting s);
const char* layoutName(bool portrait);
bool parseSetting(const char* text, Setting* out);

/** Thread-safe: may be called from the network task. The UI task applies it. */
void request(Setting s);

/**
 * UI task only. Persists a pending request; returns true once the restart is
 * due (after a short grace so a toast can be seen and the ack can flush).
 * `restartingText` is set when a restart was scheduled this call.
 */
bool poll(uint32_t nowMs, const char** restartingText);

}  // namespace StripLayout
