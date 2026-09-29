#include "../../boards/board_config.h"
#if defined(BOARD_IPS10)
#include "wake_word.h"
#include <Arduino.h>
#include <Preferences.h>
#include <atomic>
#include <cmath>
#include <new>
#include <esp_heap_caps.h>
#include <frontend.h>
#include <frontend_util.h>
#include <tensorflow/lite/micro/micro_interpreter.h>
#include <tensorflow/lite/micro/micro_mutable_op_resolver.h>
#include <tensorflow/lite/micro/micro_resource_variable.h>
#include <tensorflow/lite/schema/schema_generated.h>
#include "../util/memory.h"

extern const uint8_t modelStart[] asm("_binary_models_openclaw_wake_word_tflite_start");
namespace WakeWord {
namespace {
std::atomic<bool> isReady{false}, isEnabled{false};
std::atomic<uint32_t> detected{0}, invoked{0}, maxUs{0};
std::atomic<uint8_t> lastScore{0};
FrontendState frontend{};
tflite::MicroMutableOpResolver<13> ops;
tflite::MicroInterpreter* interpreter = nullptr;
TfLiteTensor* input = nullptr;
uint8_t slice = 0, above = 0;
uint32_t warmup = 0;
// Device-lifetime PSRAM arenas: model scratch/state cannot fit on the stack or
// compete with display/SDIO internal DMA. Allocated once, reused for every call.
constexpr size_t ARENA_BYTES = 256 * 1024, VARIABLE_BYTES = 32 * 1024;
uint8_t* arena = nullptr;
uint8_t* variables = nullptr;
alignas(tflite::MicroInterpreter) uint8_t interpreterStorage[sizeof(tflite::MicroInterpreter)];
}
bool init() {
    if (isReady) return true;
    const auto* model = tflite::GetModel(modelStart);
    if (model->version() != TFLITE_SCHEMA_VERSION) return false;
    const TfLiteStatus registered[] = {
        ops.AddCallOnce(), ops.AddVarHandle(), ops.AddReadVariable(), ops.AddAssignVariable(),
        ops.AddConcatenation(), ops.AddConv2D(), ops.AddDepthwiseConv2D(),
        ops.AddFullyConnected(), ops.AddLogistic(), ops.AddQuantize(),
        ops.AddReshape(), ops.AddSplitV(), ops.AddStridedSlice()
    };
    for (auto status : registered) if (status != kTfLiteOk) return false;
    arena = static_cast<uint8_t*>(heap_caps_aligned_alloc(16, ARENA_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    variables = static_cast<uint8_t*>(heap_caps_aligned_alloc(16, VARIABLE_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!arena || !variables) {
        Serial.println("[Wake] PSRAM arena unavailable; PTT retained");
        free(arena); free(variables); arena = variables = nullptr;
        return false;
    }
    auto* allocator = tflite::MicroAllocator::Create(variables, VARIABLE_BYTES);
    auto* resources = allocator ? tflite::MicroResourceVariables::Create(allocator, 20) : nullptr;
    if (!resources) return false;
    // Placement construction into static storage, not a fallible heap new.
    interpreter = new (interpreterStorage) tflite::MicroInterpreter(model, ops, arena, ARENA_BYTES, resources);
    if (interpreter->AllocateTensors() != kTfLiteOk) return false;
    input = interpreter->input(0);
    if (input->type != kTfLiteInt8 || input->dims->size != 3 ||
        input->dims->data[0] != 1 || input->dims->data[1] != 2 || input->dims->data[2] != 40 ||
        interpreter->output(0)->type != kTfLiteUInt8) return false;
    FrontendConfig cfg{};
    FrontendFillConfigWithDefaults(&cfg);
    cfg.window.size_ms = 30;
    cfg.window.step_size_ms = 10;
    cfg.filterbank.num_channels = 40;
    cfg.filterbank.lower_band_limit = 125;
    cfg.filterbank.upper_band_limit = 7500;
    cfg.noise_reduction.min_signal_remaining = 0.05;
    cfg.pcan_gain_control.enable_pcan = 1;
    // Upstream frontend makes bounded boot-only allocations (~10 KB), never in
    // process(). Free partial contents on failure; preserve manual dictation.
    if (!FrontendPopulateState(&cfg, &frontend, 16000)) {
        FrontendFreeStateContents(&frontend);
        return false;
    }
    Preferences prefs;
    prefs.begin("ad-voice", true);
    isEnabled = prefs.getBool("wake", false); // explicit opt-in via panel
    prefs.end();
    isReady = true;
    reset();
    Serial.printf("[Wake] OpenClaw model ready; tensor arena used=%u enabled=%d\n",
                  unsigned(interpreter->arena_used_bytes()), int(isEnabled.load()));
    logHeap("wake-ready");
    return true;
}
bool ready() { return isReady; }
bool enabled() { return isReady && isEnabled; }
void setEnabled(bool value) {
    isEnabled = value;
    Preferences prefs;
    if (prefs.begin("ad-voice", false)) { prefs.putBool("wake", value); prefs.end(); }
}
void reset() {
    if (!isReady) return;
    FrontendReset(&frontend);
    interpreter->Reset();
    slice = above = 0; warmup = 0; lastScore = 0;
}
bool process(const int16_t* mono, size_t count) {
    if (!isReady) return false;
    bool hit = false;
    while (count) {
        size_t used = 0;
        auto out = FrontendProcessSamples(&frontend, mono, count, &used);
        if (!used) break;
        mono += used; count -= used;
        if (out.size != 40) continue;
        for (size_t i = 0; i < 40; ++i) {
            // Training divides uint16 frontend output by 25.6. Quantization
            // comes from this model, not a copied model's guessed scale.
            int value = int(std::lround(out.values[i] / (25.6f * input->params.scale))) + input->params.zero_point;
            input->data.int8[slice * 40 + i] = int8_t(value < -128 ? -128 : value > 127 ? 127 : value);
        }
        if (++slice < 2) continue;
        slice = 0;
        uint32_t start = micros();
        if (interpreter->Invoke() != kTfLiteOk) { isReady = false; return false; }
        uint32_t elapsed = micros() - start;
        if (elapsed > maxUs) maxUs = elapsed;
        ++invoked;
        uint8_t probability = interpreter->output(0)->data.uint8[0];
        lastScore = probability;
        ++warmup;
        // Require sustained evidence and a warmed streaming context. Threshold
        // is deliberately conservative until tested with this panel's audio.
        above = probability >= 128 && warmup > 50 ? uint8_t(above + 1) : 0;
        if (above >= 3) { ++detected; hit = true; above = 0; break; }
    }
    return hit;
}
uint32_t detections() { return detected; }
uint32_t inferences() { return invoked; }
uint32_t maxInferenceUs() { return maxUs; }
uint8_t score() { return lastScore; }
}
#endif
