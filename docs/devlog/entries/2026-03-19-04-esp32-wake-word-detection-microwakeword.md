# 2026-03-19 — ESP32 Wake Word Detection 시도 (microWakeWord)

### 문제
Mac Studio 모니터에 달린 마이크로 Porcupine "오픈클로" wake word를 감지하고 있었으나, 모니터 sleep 시 마이크가 비활성화되어 감지 불가. ESP32 상시 전원 마이크로 해결하려 함.

### 시도
1. **Picovoice Porcupine ESP32 지원 조사**: ESP32는 Xtensa 아키텍처라 Porcupine 미지원 (ARM Cortex-M만). Console에서 ESP32 타겟으로 .ppn 모델 빌드 불가
2. **microWakeWord 선택**: TFLite Micro 기반 오픈소스 wake word 엔진. ESP32-S3 + PSRAM 네이티브 지원
3. **한국어 TTS 샘플 생성**: Piper TTS에 한국어 없어서 Edge-TTS(Microsoft)로 945개 "오픈클로" 샘플 생성 (3 음성 × 7 속도 × 3 피치 × 3 볼륨 × 5 텍스트변형)
4. **모델 훈련 성공**: Apple Silicon trainer + Metal GPU, 40,000 steps. 최종 Accuracy 100%, Recall 100%, FRR 0%. 62KB TFLite 모델 생성
5. **ESP32 I2S PDM 드라이버**: legacy API (`driver/i2s.h`) ESP-IDF 5.x에서 broken → 새 API (`driver/i2s_pdm.h`) 사용. 드라이버 정상 동작 확인
6. **TFLite Micro 빌드 실패**: pioarduino GCC 14와 오래된 TFLite Micro 라이브러리 호환 불가 (`std::is_pod` deprecated, flatbuffers 버전 충돌)
7. **마이크 하드웨어 부재 발견**: Round AMOLED (JC3636W518) 보드에 I2S 핀 정의는 있으나 MEMS 마이크 칩 미실장. I2S read 결과 DC offset ~1310 고정. 보유 3종 전부 마이크 없음

### 교훈 / 핵심 설계 결정
- **Guition(Jingcai) 디스플레이 보드**: 오디오 핀 정의 ≠ 실제 마이크 탑재. 보드 구매 시 실물 스펙 확인 필수
- **ESP-IDF 5.x I2S**: legacy API 사용 불가, `i2s_pdm.h` 새 API 필수
- **pioarduino + TFLite Micro**: GCC 14의 strict C++20 체크로 오래된 라이브러리 빌드 불가 — ESP-IDF 네이티브 빌드로 전환 필요
- **microWakeWord 훈련 환경**: arm64 Python 3.11 + TF 2.16 Metal + arm64 ffmpeg@7 (symlink `/opt/homebrew/opt/ffmpeg` 필수)
- **보관된 성과물**: `esp32/models/openclaw_wake_word.tflite`, `esp32/src/audio/`, `docs/wake-word.md`, 훈련 환경 `~/github/microWakeWord-Trainer-AppleSilicon/`
- **재개 조건**: MEMS 마이크 내장 ESP32-S3 보드 구매

---
