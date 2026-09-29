# 2026-03-21 — Voice Assistant 녹음 안정성: CoreAudio device release delay

### 문제
PvRecorder(wake word)에서 sox/rec(녹음)으로 전환 시 CoreAudio 디바이스 경합 발생. PvRecorder.stop()이 비동기로 디바이스를 해제하므로 rec가 즉시 시작하면 corrupted/empty 오디오 캡처.

### 해결
1. **300ms delay**: PvRecorder stop → 300ms setTimeout → rec start (device release 대기)
2. **Retry on empty**: RMS > threshold×3인데 전사 비어있으면 1회 재녹음 시도
3. **Log 가시성**: debug() → log() (Transcription result, Sending prompt)
4. **Doc update**: Piper TTS → macOS say (현재 구현 반영)

### 교훈
- CoreAudio 디바이스 해제는 비동기 — stop() 반환 후에도 ~200ms 점유 가능
- RMS가 높은데 전사 비어있으면 녹음 품질 문제 (hallucination 아닌 device contention)

---
