# 2026-04-12 — Device disconnect UX + daemon TDZ crash

### 문제
1. **Pixoo 데몬 종료 시 화면 멈춤**: push-only HTTP 기기라 데몬이 꺼지면 마지막 terrarium 프레임에서 정지 — 사용자에게 상태 불명확
2. **ESP32 "NO WIFI" 오표시**: TC001 + LVGL 3종이 데몬 종료 시 "NO WIFI" 표시. 실제 문제는 daemon 오프라인인데 WiFi 상태로 판단하는 로직 오류
3. **D200H 화면 미표시**: `daemon-server.ts`의 `gatewayAdapter`가 HTTP 서버 핸들러보다 뒤에 `let` 선언 → ESP32/앱이 서버 시작 직후 `/health` 요청 → TDZ ReferenceError로 데몬 crash → D200H 모듈 초기화 불가

### 해결
1. **Pixoo**: `stopPixooBridge()`를 async로 변경, 종료 전 검은 배경 + 회색 "OFFLINE" 프레임을 push (2s 타임아웃)
2. **ESP32 TC001**: `buildDisconnectMsg()` — `everGotData` true면 항상 "OFFLINE" (WiFi 무관). LVGL boards: `everConnected` 체크를 WiFi 체크보다 우선
3. **daemon TDZ**: `gatewayAdapter` + `gatewayConnecting` 선언을 HTTP 서버 설정 전으로 이동

### 핵심 설계 결정
- ESP32 disconnect 판단: `lastMessageMs != 0` (한 번이라도 데이터 받았음) → 항상 "OFFLINE". WiFi 상태와 무관하게 "daemon이 사라졌다"가 정확한 상태
- Pixoo는 push-only이므로 정적 프레임만 가능 (ESP32처럼 breathing 애니메이션 불가)
- TDZ 교훈: `let`/`const`는 같은 함수 스코프여도 선언 라인 이전에 클로저에서 접근하면 crash. HTTP 핸들러처럼 비동기로 호출되는 클로저는 변수 선언 순서에 민감

---
