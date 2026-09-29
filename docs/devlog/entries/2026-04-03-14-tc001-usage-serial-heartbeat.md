# 2026-04-03 — TC001 Usage 가독성 + 에이전트 크리처 분리 + Serial Heartbeat 수정

### 문제
(1) TC001 Usage 게이지에서 퍼센트/리셋 시간 텍스트가 Pixoo 대비 가독성 떨어짐 — fill과 텍스트가 같은 색이거나 대비 부족 (2) 에이전트 4종(Claude/Codex/OpenCode/OpenClaw) 실행 중인데 TC001에서 문어 3개 + 가재 1개만 표시 — Codex/OpenCode 전용 스프라이트 없음 (3) AGENTS 페이지 스크롤이 끝에서 갑자기 처음으로 점프 (4) ESP32 기기에서 간헐적 SEARCHING 표시

### 해결
**Usage 가독성**: Pixoo 전략 벤치마크 — fill을 20% 밝기로 어둡게 (dimFill), 퍼센트 텍스트 흰색(255,255,255), 리셋 시간 Pixoo와 동일 (0x60,0x70,0x80). 리셋 시간 포맷 후행 단위 생략 (`3H22M`→`3H22`).

**에이전트 크리처**: 해파리(SPR_JELLYFISH, Codex CLI), 네모(SPR_OPENCODE, OpenCode) 5×6 스프라이트 추가. AgentKind enum으로 타입별 색상+스프라이트 분리. OpenCode=cyan 색조.

**스크롤**: ping-pong 방식 (3초 멈춤→ease-in-out 슬라이드→3초 멈춤→역방향 슬라이드). smoothstep `t*t*(3-2t)` 적용.

**Serial Heartbeat**: Swift daemon `lastStateEvent`가 startup 시 nil → heartbeat에서 JSON 미전송 → 10초 timeout → SEARCHING. (1) startup 직후 `buildFullStateEvent()` seed (2) heartbeat 5s→3s 단축 (3) state/usage 모두 nil일 때 `{"type":"keepalive"}` fallback.

### 핵심 설계 결정
- **TC001 퍼센트 텍스트는 흰색**: 게이지 컬러 텍스트는 fill 위에서 대비 없음. LED 매트릭스 특성상 밝은 흰색이 dimmed fill 위에서 가장 선명
- **Fill 밝기 20%**: Pixoo의 35%보다 더 낮게 — LED 매트릭스는 LCD보다 밝은 색이 눈에 더 강하게 번져서 더 어두운 fill이 필요
- **Keepalive JSON 패턴**: ESP32 serial_client는 `serialBuf[0]=='{'` 체크만으로 JSON 인식 → `{"type":"keepalive"}`도 `lastSerialJsonMs` 갱신. TC001 코드 수정 불필요
- **Daemon serial port 점유**: daemon이 시리얼 포트를 열고 있으면 esptool 플래시 실패 — daemon 중지 후 플래시 필수

---
