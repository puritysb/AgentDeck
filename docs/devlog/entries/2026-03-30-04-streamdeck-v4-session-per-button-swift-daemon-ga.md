# 2026-03-30 — StreamDeck v4 Session-per-Button + Swift Daemon Gap Analysis

### 문제
v3 고정 레이아웃(Mode/Session/Usage/QuickAction/Stop)에서 멀티세션 운영이 비직관적. Session 버튼 하나로 선형 순환해야 했음. 또한 Swift daemon(macOS 앱)에서 기기 모듈(Serial/ADB/Pixoo)이 동작하지 않음.

### 해결 (Plugin v4 — 완료)
- Session-per-button 동적 레이아웃: 8개 버튼에 세션 동적 할당 (OC 우선)
- Detail View: 세션 press → BACK/Info/Options/ESC
- SessionFocusRelay: daemon 경유 양방향 세션 릴레이 (Node.js + Swift)
- Plugin → daemon 전용 연결 (session bridge 직접 연결 제거)
- E1 Utility에 Usage/Mode 모드 추가

### 미해결 (Swift Daemon Device Modules)
Swift daemon에서 기기 모듈이 런타임에 동작하지 않음. 코드 수정은 했지만 검증 실패:
- **ESP32 Serial**: `cu.wchusbserial` 패턴 추가 + state provider 연결 → 포트 안 열림
- **ADB**: `findAdb()` 경로 탐색 추가 → reverse 안 설정됨
- **Pixoo**: `broadcastHooks` 수정 + display sleep 추가 → 프레임 안 나감
- **Model catalog**: dedup `name`→`key` 변경 + Gateway 핸들러 추가 → 미검증

**근본 원인 미확인** — 파일 로깅(`swift-daemon.log`) 추가했으나 아직 로그 분석 안 됨. Xcode 콘솔 디버깅 필요.

### 핵심 설계 결정
1. Plugin은 daemon에만 연결 (session bridge 직접 연결 금지)
2. `focus_session` 명령으로 daemon이 특정 세션에 WS 구독 + 양방향 릴레이
3. `SessionFocusRelay`가 state_update 릴레이 시 daemon 메타데이터(modelCatalog, gatewayAvailable, ollamaStatus) 머지
4. `applicationWillTerminate`에서 daemon shutdown (포트 해제)

---
