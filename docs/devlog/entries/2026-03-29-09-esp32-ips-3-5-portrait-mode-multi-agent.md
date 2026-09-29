# 2026-03-29 — ESP32 IPS 3.5" Portrait Mode + Multi-agent 버그 수정

### 문제
1. OpenCode 크리처가 ESP32/Stream Deck에 안 보임
2. 86 Box (CH340) daemon 시리얼 연결 안 됨
3. IPS 3.5" 세로 모드 지원 필요
4. IPS 3.5" 터치 미동작 (하드웨어 이슈로 판단 — 원본 펌웨어에서도 동일)

### 해결
1. **OpenCode 미표시**: `bridge/src/index.ts`에서 OpenCodeAdapter의 HookServer 초기화 누락 → `/health`에 state/agentType 없음 → sessions_list enrichment 실패. Plugin에서도 `proxiedAgentType`이 'opencode'를 인식 안 함 → `capsForProxiedAgent()` 헬퍼 추가
2. **CH340 미감지**: `esp32-serial.ts`의 `detectESP32Ports()`가 `ls /dev/cu.usb*`만 사용 → `cu.wchusbserial*` 누락. `ESP32_PORT_PATTERNS`에도 `cu.wchusbserial` 정규식 없음
3. **Portrait 모드**: `SCREEN_W`/`SCREEN_H` constexpr → `g_screenW`/`g_screenH` 런타임 전역변수. `UI::setOrientation()` + NVS 영속 + `set_orientation` 프로토콜 + Settings 토글. HUD portrait: 전체폭 상단 패널 + bottom-right 탱크 스택
4. **터치**: git checkout으로 원본 복원해도 동일 — 코드 변경 무관, FPC 커넥터 또는 라이브러리 업데이트 이슈

### 핵심 설계 결정
- `g_screenW`/`g_screenH` 전역변수 선택 (함수호출 대비 hot loop 성능 보존 — setPixel에서 수십만회/프레임 접근)
- canvas_buf 재할당 불필요 (320×480 = 480×320 = 동일 153,600px)
- 화면 전환 시 LVGL 스크린 전체 재생성 (부분 업데이트보다 단순하고 안전)
- NVS `Preferences` 사용 (ESP32 Arduino 내장, 추가 의존성 없음)

---
