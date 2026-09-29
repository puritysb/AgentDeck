# 2026-04-03 — D200H Multi-Session Agent Controller + Heartbeat Resilience

### 문제
D200H HID 통신 완성 후: (1) 버튼 레이아웃이 SD+ 구조를 기계적 복사, UX 의도 없음 (2) daemon 재시작/USB 재연결 시 기본 화면 복구 안 됨 (3) Node.js bridge d200h-module이 동시에 써서 화면 충돌

### 해결
- 세션 중심 멀티 에이전트 컨트롤러: 13슬롯 전부 세션 → 누르면 detail view (퀵 액션 + ESC/STOP)
- Heartbeat 15초: SET_BUTTONS 강제 재전송 + keep-alive
- Node.js bridge에서 D200H 모듈 제거: Swift daemon 단독 제어
- SD+ 플러그인에 CC 퀵 액션 프리셋 추가

### 핵심 설계 결정
- **CoreText PNG는 D200H가 거부** — ~4KB+ PNG는 디바이스가 무시. device native text(manifest Text)만 사용
- **seize 불필요** — D200H 커스텀 프로토콜(0x7C7C)은 macOS hidd가 intercept 안 함
- **App Sandbox 호환** — sandboxed macOS 타깃은 `com.apple.security.device.usb` entitlement가 있어야 HID `IOHIDDeviceOpen`이 가능하다. Keyboard 인터페이스는 여기에 더해 Input Monitoring 재승인/앱 재시작이 필요할 수 있다
- **strmdck 프로토콜 참조** — Ulanzi SDK 미사용, 커뮤니티 리버스 엔지니어링 기반

---
