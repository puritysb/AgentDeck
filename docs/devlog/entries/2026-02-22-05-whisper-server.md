# 2026-02-22 — whisper-server 통합으로 음성 전사 지연 해소

### 문제

음성 전사 호출마다 `whisper-cli`가 1.5GB `large-v3-turbo` 모델을 GPU 메모리에 로드→추론→언로드. 모델 로드/언로드 오버헤드가 추론보다 큰 병목 (호출당 ~5-10초).

### 해결

`whisper-server` (whisper.cpp 내장 HTTP 서버)를 브릿지 수명 주기에 통합하여 모델 상주:

- **서버 수명 관리**: `VoiceManager.startServer()` / `stopServer()` — 브릿지 시작 시 비동기 스폰, 종료 시 SIGTERM+3s SIGKILL
- **포트 할당**: `bridgePort + 10` (9120→9130) — 브릿지 포트 범위(9120-9129)와 겹치지 않음
- **HTTP 전사**: `POST /inference` multipart form-data (외부 의존성 없이 수동 boundary 구성)
- **라우팅**: `useServer && whisperServerReady` → 서버 모드, 실패 시 자동 CLI 폴백
- **리샘플 스킵**: 서버 모드에서 sox 리샘플 생략 (`--convert` 플래그로 서버가 자체 변환) → ~100-300ms 추가 절감
- **Readiness 폴링**: 500ms 간격 최대 30초, 모델 로드 완료 후 서버가 listen 시작하므로 아무 HTTP 응답 = ready
- **크래시 복구**: 서버 프로세스 `exit` 이벤트에서 `useServer=false` 설정 → 다음 호출부터 CLI 폴백

### 결과

- 예상 지연: ~5-10s → <2s (모델 상주 + 리샘플 생략)
- `whisper-server` 미설치 시 기존 `whisper-cli` 경로 100% 유지 (무손실 폴백)
- `check-deps.ts`에 선택적 의존성 추가 (설치 안내만, 필수 아님)

---
