# Wake Word Detection

> **Status (2026-09-23):** Deployed to IPS10 and the Mac Studio Node daemon.
> An acoustic synthetic-speech test passed wake detection → capture → HTTP
> upload → personal OpenClaw run → local TTS → panel playback → listening again.
> This is a hardware smoke test, not a room-distance accuracy measurement.

## Recognition diagnostics (2026-09-24)

For a wake that reacts but misrecognizes the following utterance, inspect the
running daemon as well as the settings. The Mac Studio was running an older
npm installation that called Apple Speech directly, while its local settings
selected `whisper-cpp`, `ko-KR`, and `large-v3-turbo`. Updating the source tree or
firmware alone did not change that running implementation. The current loopback
health response reports `voice.transcriber`, `voice.locale`, and
`voice.personalRoute`; these describe configuration, not model readiness or
recognition quality. The CLI now resolves to the stable main checkout rather
than a temporary worktree. Previously captured microphone audio still produced
some incorrect words when replayed through Whisper, so a successful round trip
must not be reported as a room-distance recognition-accuracy result.

The v8 hardware check also exposed an independent upload failure: the workspace
left roughly 49 KiB internal heap against the existing 60 KiB WiFi TX guard.
IPS10 now uses three 8-line internal DMA buffers, returning 60 KiB without moving
per-pixel rendering into slower PSRAM. The upload guard remains intact. On the post-flash check, internal free memory
settled at 106–108 KiB (largest block 62–65 KiB). The triggered utterance uploaded
successfully on its first attempt, received a personal OpenClaw response, played
it on the panel, and returned to wake state. This remains a synthetic-speech
smoke test, not a recognition-accuracy benchmark.

## IPS10 desk companion

The on-device **OpenClaw** button enables/disables the local Korean wake-word
model and retains the setting across reboot. New installations default off.
Say **오픈클로**, wait for the short listening tone, then speak the command.
A pause ends the utterance; the stop button cancels recording or stops playback.
During reply playback the listener is suppressed, so the speaker cannot trigger
itself. This is half-duplex voice interaction, not acoustic echo cancellation.
Manual hold-to-talk is retained. Tap a work card for task details; hold a card
to choose the manual voice target. Wake-word requests always address the
personal OpenClaw session regardless of the selected work card.

The foreground dashboard shows current work or the last outcome, with event
history behind the detail view. Empty child-agent telemetry is omitted instead
of filling cards with diagnostic text. Voice status and stop controls remain
visible below the work area.

### Surface and camera decisions

IPS10 is the desk's glanceable work surface: stable agent/project cards answer
who is working, on what, and whether input is needed. A tap reveals the details;
the default view does not repeat a timeline under every agent. The office scene
continues to use real agent state. Blender-authored baked poses can extend that
scene later; this change does not introduce a real-time 3D renderer.

Voice has an always-visible enable/disable control, listening feedback,
silence endpointing, and a stop control. It uses the panel microphone even when
the Mac display sleeps. Room-distance recognition, acoustic echo cancellation,
and speaking over an answer are not established by the synthetic smoke tests.

For the unused front camera, the first useful experiments are opt-in presence
(to switch between glance and detail density) and a user-requested still image
for a question to the personal agent. Prefer local, low-rate processing and
retain no frames for presence. Person identity, emotion, and attention are not
needed. CSI capture/ISP integration, frame validation, and resource coexistence
with display/audio must precede any lightweight vision model. The firmware's
`camera_probe` only reads the expected sensor ID over the existing SCCB bus; it
does not start a camera stream or claim successful capture.

### Transport and ownership

- IPS10 owns I2S RX in one lifetime task. Its frontend, streaming model state,
  pre-roll and bounded 30-second capture reuse boot allocations. Capture and
  model arenas live in PSRAM. The upload borrows a frozen capture buffer;
  another recording cannot overwrite it while the HTTP worker owns it.
- Only a triggered utterance is sent over the existing paired Wi-Fi voice
  endpoint. Wake-word processing requires no cloud audio stream.
- The Node daemon acknowledges receipt before transcription, then calls `chat.send` on
  `agent:main:main` (override: `voice.openclawSessionKey`, restricted to an
  agent's main session). It matches both the acknowledged run ID and session
  key before speaking. Cron and unrelated chat completions cannot provide
  the response. Existing `voice.locale` and `voice.speakReplies` apply.
- `voice.transcriber` defaults to `apple`. `whisper-cpp` selects an explicitly
  configured local `voice.whisperCli` and `voice.whisperModel` (absolute paths).
  It has a 60-second timeout, uses argument-based process execution, and never
  downloads a model or sends audio to a cloud ASR service. This Mac Studio uses
  its existing native ARM64 Whisper and large-v3-turbo model because Apple
  Speech authorization stalled in the launchd helper. TTS still uses the
  existing native speech helper.
- This personal-session route currently requires the Node daemon on the Mac
  Studio. The Swift daemon has not gained the new personal voice route.
- Firmware diagnostics expose `wakeReady`, `wakeEnabled`, detection/inference
  counters, worst inference time, score, microphone level and voice phase in
  a requested `device_info` frame. `wake_word_config` changes the persisted
  setting; `mic_test` reads the owner's telemetry without stealing I2S frames.

### Model and limits

The embedded 63,520-byte model uses 40-channel frontend features at 16 kHz,
30 ms windows / 10 ms steps, and two slices per invocation. The frontend is
pinned to `esphome-libs/esp-micro-speech-features` commit
`351c4c69530f5a802da5433581c4863afadf0a00` (Apache-2.0).
Detection requires three consecutive outputs at least 128/256 after warm-up.
The frontend uses its ESP32 PSRAM allocator; IPS10 omits the unused 12 KB
streaming ring. Hardware upload headroom increased from 56 KB to 80 KB.

A 12-sample training-audio smoke test reached detection on all samples; this
is not a held-out accuracy or far-field false-trigger result.

Camera support remains a separate hardware bring-up: this repository has no
IPS10 CSI capture driver. A new [OV02C10 component tested on this board](https://github.com/sullb/esphome-p4-csi-camera)
provides a useful implementation reference. The deployed read-only probe confirmed
`0x5602` (OV02C10) on this unit; no video frame has been captured. Useful first features
are opt-in presence-based information density and an explicitly requested still
image for the personal agent. Do not infer identity, emotion or attention from
presence, or claim a camera feature before a real frame has been validated.


### Deployment verification (2026-09-23)

- IPS10 USB deployment: ESP32-P4 revision 1.3, detected 16 MB flash, full image
  write with hash verification and hard reset. Running build epoch `1790127440`
  (`3fe22c11-dirty`, compiled before commit `310d2c8e`) was read back from the
  device. A preceding Wi-Fi OTA timed out at chunk 3290; USB completed.
- Mac Studio: supervised Node daemon build `ad38d0e5312e`, source CLI linked to
  the stable checkout. Local Whisper transcribes Korean; the existing native
  helper generates 16 kHz speech. HTTP receipt returned in 67 ms in a host test.
- Initial acoustic testing passed a full round trip, then a repeated upload
  stalled at 81,920/200,512 bytes. Firmware now uses nonblocking 512-byte sends,
  drains WS/serial control traffic during transfer, and bounds both total and
  stalled duration. Two subsequent 200,512-byte uploads returned HTTP 200 and
  both replies completed on the same boot. Idle internal heap returned to 79 KB.
- A subsequent 8 KB reply-download burst briefly drove minimum internal heap to
  2 KB. The Mac now paces IPS10 replies at 1 KB/20 ms, above 16 kHz mono playback
  rate; firmware starts playback before the entire answer has arrived. A final
  404,812-byte reply was downloaded/fed completely; minimum internal heap on
  that boot stayed at 63 KB, versus 2 KB before host pacing.
- A Korean negative utterance caused no additional detection. Wake-only speech
  followed by silence returned to listening without uploading a command.
  Muting froze the inference/detection counters even when the wake word played;
  re-enabling restored the listener. The enabled preference survived reboot.
- **Recognition limitation:** replaying the captured microphone WAV through
  the local recognizer produced word substitutions (for example, requested
  “음성 연결 확인” became “음성 연결 고민”). Successful delivery/playback does not
  establish faithful command transcription. Human speech, placement/distance,
  background noise and language accuracy need a broader acceptance set. The
  current recognizer is local Whisper, not a calibrated far-field speech system.
  One later acoustic replay also failed to wake the panel; a successful local
  listening loop does not guarantee detection of every utterance. Manual PTT
  remains available when the wake word is missed.
- Native LVGL simulations passed tap/detail/close/hold/wake-toggle interactions
  and modal bounds in landscape and portrait. Build, typecheck and 4,654 tests
  passed (2 skipped). Protocol generation and token mirrors passed. Design lint
  still reports pre-existing HTML/JS violations outside the changed files.


## 1. Porcupine (Mac — 현재 운영)

Mac Studio 모니터 마이크로 "오픈클로" 키워드 감지.

- **엔진**: Picovoice Porcupine (`@picovoice/porcupine-node`)
- **키워드**: `~/.agentdeck/wake-word/*.ppn` (한국어 커스텀 모델)
- **언어모델**: `~/.agentdeck/wake-word/*.pv` (Korean)
- **Access key**: `~/.agentdeck/picovoice-key.txt`
- **코드**: `bridge/src/wake-word.ts` — `WakeWordListener` class
- **설정**: `~/.agentdeck/settings.json` — `wakeWordMic`, `wakeWordSensitivity`
- **제한**: 모니터 sleep 시 마이크 비활성 → 감지 불가

## 2. microWakeWord training history

목표는 ESP32-S3의 내장 마이크로 상시 감지해서 모니터가 잠들어도 동작하게 하는 것이었다. 2026-08-05의 제거 경위는 아래에 보존한다. 현재 IPS10 구현은 위 절을 참조한다.

- **엔진**: microWakeWord (TFLite Micro, MixConv streaming)
- **모델**: `esp32/models/openclaw_wake_word.tflite` (62KB, INT8 양자화)
- **타겟 보드**: Round AMOLED JC3636W518 (ESP32-S3, I2S PDM mic GPIO45/46)
- **추론**: ~0.026M MACs, <10ms per frame on ESP32-S3

### 모델 훈련 환경

```
~/github/microWakeWord-Trainer-AppleSilicon/
├── .venv/                    # arm64 Python 3.11 + TF 2.16 + Metal
├── generated_samples/        # Edge-TTS 한국어 945개 WAV (16kHz mono)
├── generate_korean_samples.py  # Edge-TTS 샘플 생성 스크립트
├── train_openclaw_ko.sh      # 한국어 훈련 래퍼
├── trained_models/           # 훈련된 모델
└── micro-wake-word/          # microWakeWord 소스 (TaterTotterson fork)
```

### 훈련 파이프라인

1. **샘플 생성** (Edge-TTS — Piper에 한국어 없음)
   - 3 음성: SunHi(여), InJoon(남), Hyunsu(남 다국어)
   - 7 속도 × 3 피치 × 3 볼륨 × 5 텍스트변형 = 945개
   - `uv run --python 3.11 --with edge-tts -- python generate_korean_samples.py`

2. **증강 데이터셋** (자동 다운로드)
   - MIT RIR (270 room impulse responses)
   - AudioSet (18,683 clips)
   - FMA xsmall (210 music clips)
   - WHAM (28,000 noise clips)
   - CHiME-Home (실패 — archive.org 불안정, 다른 3개로 충분)

3. **Feature 생성** — 40-feature spectrograms, SpecAugment, background noise 5-10dB SNR

4. **훈련** — 40,000 steps, Metal GPU (M1 Max), ~30분
   - MixConv: `[5], [7,11], [9,15], [23]` kernels, 64 pointwise filters
   - 최종: Accuracy 1.000, Recall 1.000, Precision 1.000, Loss 0.0002
   - FRR 0%, FAPH 0.19 at cutoff 0.07

5. **출력** — `stream_state_internal_quant.tflite` (62KB INT8)

### 재훈련

```bash
cd ~/github/microWakeWord-Trainer-AppleSilicon
source .venv/bin/activate

# 샘플 재생성 (필요시)
WAKE_WORD="오픈클로" uv run --python 3.11 --with edge-tts -- python generate_korean_samples.py

# 훈련 (기존 샘플 + 데이터셋 재사용)
export TARGET_WORD="오픈클로" MWW_LANGUAGE="ko"
python scripts_macos/make_features.py
python scripts_macos/fetch_negatives.py
python scripts_macos/write_training_yaml.py
python -m microwakeword.model_train_eval \
  --training_config=training_parameters.yaml \
  --train 1 --restore_checkpoint 1 \
  --test_tflite_streaming_quantized 1 \
  --use_weights "best_weights" \
  mixednet \
  --pointwise_filters "64,64,64,64" \
  --repeat_in_block "1,1,1,1" \
  --mixconv_kernel_sizes "[5], [7,11], [9,15], [23]" \
  --residual_connection "0,0,0,0" \
  --first_conv_filters 32 \
  --first_conv_kernel_size 5 \
  --stride 2

# 모델 복사
cp trained_models/wakeword/tflite_stream_state_internal_quant/stream_state_internal_quant.tflite \
   ~/github/AgentDeck/esp32/models/openclaw_wake_word.tflite
```

### 환경 의존성

- **Python**: 3.11 arm64 (`uv python install 3.11`)
- **TensorFlow**: 2.16.2 + tensorflow-metal 1.2.0 (Metal GPU)
- **ffmpeg**: arm64 (`/opt/homebrew/opt/ffmpeg@7`), symlink `/opt/homebrew/opt/ffmpeg` 필수
- **torchcodec**: ffmpeg@7 rpath 의존 — symlink 없으면 import 실패

### ESP32 통합 (2026-08-05 제거됨)

펌웨어 쪽 코드는 지웠다. 지운 이유는 하드웨어가 없어서가 아니라, **남아 있던 코드가 이름값을 못 했기 때문이다**:

- `wake_word.cpp` 는 I2S PDM RX + RMS VAD 까지만 구현돼 있었고 **TFLite 인터프리터를 부르는 코드가 없었다** — 파일 이름과 헤더 주석만 microWakeWord 였다.
- 어떤 보드 코드도 `Audio::wakeWordInit/Start` 를 호출하지 않았다. 유일한 게이트 `BOARD_HAS_AUDIO` 는 실장 보드에서 `0`, 나머지에서는 주석 처리 상태였다.
- 63,520 B 모델이 `wake_word_model.h` 에 C 배열로 임베드돼 있었다(소스 397 KB). 아무도 읽지 않는 배열이 매 빌드마다 따라다녔다.

삭제된 것: `esp32/src/audio/wake_word.{cpp,h}`, `esp32/src/audio/wake_word_model.h`, 보드 헤더의 `BOARD_HAS_AUDIO`, `platformio.ini` 의 `-<audio/wake_word.*>` 제외 규칙.
**남긴 것**: `esp32/models/openclaw_wake_word.tflite` (62 KB, 훈련 산출물) — 위 훈련 파이프라인의 결과물이고, 재개하면 그대로 다시 임베드하면 된다.

보유 보드의 마이크 사정도 그대로다:
- Round AMOLED (JC3636W518): 핀 정의만 있고 칩 미실장 — I2S PDM 테스트 결과 DC offset(~1310) 고정
- 86 Box (4848S040) · IPS 3.5" (JC3248W535): 오디오 핀 없음
- IPS 10.1" (JC8012P4A1C): ES8311 코덱 실장 확인 — 단 push-to-talk 캡처/재생 경로로만 쓰고 있다 (`mic_capture.cpp` / `speaker_playback.cpp`, 별도 기능)

**재개 조건 (셋 다 필요):**
1. 상시 켜둘 마이크가 있는 보드 — IPS 10.1" 의 ES8311 ADC 를 상시 캡처로 돌리거나, MEMS 마이크 내장 S3 보드(ESP32-S3-BOX-3, INMP441 모듈 등)
2. TFLite Micro 추론 실제 구현 — pioarduino GCC 14 호환 라이브러리 또는 ESP-IDF 네이티브 빌드, + 40-feature 스펙트로그램 프런트엔드
3. 실기 검증 — 이 저장소의 ESP32 규칙상 하드웨어에서 확인하기 전에는 "동작한다"고 쓰지 않는다

복원 지점: 삭제 커밋의 `esp32/src/audio/wake_word.*` (git 히스토리에 그대로 있다).

### Porcupine vs microWakeWord

| | Porcupine (Mac) | microWakeWord (ESP32) |
|---|---|---|
| 플랫폼 | macOS arm64 | ESP32-S3 |
| 모델 | .ppn (Picovoice Console) | .tflite (자체 훈련) |
| 비용 | Picovoice 라이선스 | 무료 (오픈소스) |
| 한국어 | 지원 (커스텀 키워드) | TTS 합성 훈련 |
| 항상 켜짐 | 모니터 의존 | 독립 (ESP32 상시 전원) |
| 정확도 | 높음 (상용) | 높음 (TTS 훈련 한계 있음) |
