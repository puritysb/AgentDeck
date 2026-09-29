# 2026-07-04 — observed Codex 상태 양방향 오판 교정 + display sleep 하트비트 자가치유

### 문제
1. **observed Codex 세션이 유령 processing 고착**: 놀고 있는데 대시보드에 processing 표시. `passive-observer.ts parseCodexRollout`이 큰 rollout(>1.25MB)을 head 256KB + tail 1MB로 샘플링하는데, head 구간 `function_call`의 `function_call_output`이 head–tail 갭에 떨어지면 `pendingCalls`가 영구 잔류 → 파일이 `task_complete`로 끝나도 processing. 실측 3.4MB rollout에서 dangling call 5개.
2. **(1) 수정이 반대 방향 유령 idle을 노출**: 작업 중인데 idle 표시(움직임 안 보임). 구 로직은 `function_call`·mid-turn `agent_message`가 `modelGenerating=false`로 turn을 꺼서, 첫 tool call 이후 상태가 pendingCalls에만 의존 → tool output 직후~다음 call 사이 thinking 구간이 전부 idle. 실제 rollout 리플레이에서 **턴 진행 시간의 13%만 processing** 표시.
3. **TC001 등 serial LED 패널이 화면 꺼진 채 고착**(전원 재연결로만 복구). `display_state`가 순수 엣지 트리거(상태 변경 시 + serial 연결 시)라, off 수신 후 wake 엣지를 놓치면(half-open serial, 데몬 교대 타이밍) 재전송이 없어 영구 소등.

### 해결
- **turn 단위 상태 의미론** (`passive-observer.ts`): `task_started`/`user_message`에서 turnActive=true(+user_message에서 pendingCalls.clear()), `task_complete`/`turn_aborted`에서만 turnActive=false + pendingCalls.clear(). mid-turn 이벤트는 turn 상태 불변. state = `turnActive || pending>0`. end-event 유실 유령 방지 백스톱: processing인데 pending 없음 + rollout mtime 10분 초과 침묵 → idle(in-flight tool 있으면 면제 — 조용한 장기 빌드 보호).
- **display_state 하트비트 재동기화** (Node `esp32-serial.ts` `sendHeartbeat` + Swift `ESP32Serial.swift` `sendHeartbeat`/`SerialEventSnapshot.currentDisplayStateEvent`): state/usage는 이미 매 5초 재전송하고 있었으나 display_state만 빠져 있었음. 매 주기 재전송 추가(페이로드 ~70B, 펌웨어 핸들러 멱등) → wake 엣지 유실돼도 5초 내 자가치유.

### 핵심 설계 결정
- 부분 샘플 기반 상태 파생은 (a) 경계 이벤트에서 pending 리셋, (b) mid-turn 이벤트가 활성 상태를 끄지 않게 — **두 원칙 모두** 필요. 하나만 고치면 반대 방향 유령이 드러난다(방향 1 수정이 방향 2를 노출).
- Swift 데몬은 rollout 파싱을 안 하므로(`LocalCodexAppObserver`는 프로세스 존재만 감지) Codex 수정은 Node 전용. 반면 display_state 하트비트 결함은 Swift에도 대칭 존재 → 양쪽 수정.
- 검증: vitest 1655 pass, Android JUnit 195 pass, `xcodebuild AgentDeck_macOS` BUILD SUCCEEDED. 실기 육안 확인은 사용자 세션에서 데몬/앱 재시작 후.
