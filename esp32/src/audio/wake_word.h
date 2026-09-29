#pragma once
#include <stddef.h>
#include <stdint.h>
// IPS10 only. All inference runs on the single microphone owner task.
namespace WakeWord {
bool init();
bool ready();
bool enabled();
void setEnabled(bool value);
void reset();
bool process(const int16_t* mono, size_t count);
uint32_t detections();
uint32_t inferences();
uint32_t maxInferenceUs();
uint8_t score();
}
