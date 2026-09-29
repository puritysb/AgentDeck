# 2026-03-01 — Android Deck: Full SD+ Encoder Mirroring + Voice + Utility Proxy

### 문제
Android Deck 탭이 8개 버튼만 표시하고 SD+의 핵심인 4개 인코더(다이얼+LCD)가 빠져 있었음. 또한 버튼 슬롯 배치가 하드코딩되어 SD+ 프로필 변경과 동기화되지 않음.

### 해결
**Protocol 확장** (`shared/src/protocol.ts`): `EncoderSlotState`, `EncoderStateEvent`, `DeckSlotMapEvent`, `UtilityCommand` 타입 추가. Bridge가 인코더 LCD 콘텐츠를 자체 계산하여 모든 클라이언트에 broadcast.

**Bridge 인프라**: (1) `utility-proxy.ts` — osascript로 macOS 볼륨/밝기/미디어 제어, 5초 폴링 (2) `computeEncoderState()` — E1~E4 상태 계산 + `state_changed` 이벤트마다 broadcast (3) `POST /voice/transcribe` — Android 음성 WAV 수신 → whisper 전사 (4) `deck_slot_map` 캐시 + 릴레이

**Plugin 슬롯 맵 보고**: `willAppear`에서 좌표 수집 → 디바운스 500ms → `deck_slot_map` WS 전송

**Android**: (1) `EncoderStrip.kt` + `EncoderPanel.kt` — 4패널 LCD 미러링, 수평 드래그/탭/롱프레스 제스처 (2) `VoiceRecorder.kt` — AudioRecord 16kHz PCM → WAV → HTTP 업로드 (3) `DeckScreen.kt` — 인코더 스트립 + 버튼 그리드 + 컨텍스트 영역 통합 (4) Dashboard 테라리움 축소 0.35→0.25, 인코더 미니 스트립 추가

### 교훈 / 핵심 설계 결정
- **Bridge-centric 인코더 상태**: 인코더 LCD 콘텐츠를 Bridge가 계산 (plugin이 아님). Plugin은 SD+ 하드웨어에 SVG 렌더링, Bridge는 JSON 상태를 Android/SSE 클라이언트에 broadcast. 동일 데이터의 렌더링만 표면별로 다름
- **슬롯 맵 릴레이 패턴**: Plugin이 실제 SD+ 프로필의 슬롯 배치를 보고 → Bridge 캐시 → Android 미러링. Plugin 미연결 시 기본 v3 레이아웃 폴백
- **Android 음성 경로**: 로컬 AudioRecord → WAV 빌드 → HTTP POST to Bridge → whisper. Plugin의 iTerm2/sox 경로와 달리 네트워크 전송 필요하므로 HTTP 엔드포인트 추가

---
