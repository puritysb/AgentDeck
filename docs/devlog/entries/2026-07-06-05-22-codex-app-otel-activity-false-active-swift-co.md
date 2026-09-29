# 2026-07-06 — 라운드 22: Codex App OTel activity false-active + Swift Codex 응답 본문 복구

### 문제
Codex 데스크톱 앱이 켜져 있기만 한 상태에서 Swift 데몬이 `observed:codex-app:<pid>`를 `processing` 세션처럼 표시했다. 원인은 Codex App/app-server가 내보내는 OTel `receiving`/`stream.request`류 activity span을 실제 사용자 turn 신호처럼 처리한 것. 별개로 Swift 데몬의 Codex CLI hook 경로는 `codex_stop`/`codex_turn_complete` payload만 보고 응답 본문을 찾았는데, 실제 Codex 답변은 대개 rollout JSONL에 있어 타임라인이 질문→답변 한 턴이 아니라 빈 완료/독립 세션처럼 보였다(Node 데몬은 이미 rollout tail reader 보유).

### 해결
- Swift `handleCodexTrace`: OTel `activity`는 새 Codex App 세션 생성 또는 idle→processing 승격에 쓰지 않고, 이미 `turnStart`/`toolCall`로 `processing`인 세션의 freshness 갱신에만 사용. `turnStart`/`toolCall`/`turnEnd`가 상태 전이의 권위 신호.
- Swift `LocalCodexAppObserver`: 최상위 `/Applications/Codex.app` 실행 여부만으로 만들던 `observed:codex-app:<pid>` fallback 제거. 세션 목록에는 `kernel.js --session-id/--working-dir`처럼 durable session metadata가 있는 Codex App 프로세스만 노출해, 단순 앱 실행 상태를 에이전트 세션으로 오인하지 않게 함.
- Swift `CodexRolloutResponseReader` 추가: `~/.codex/sessions/<y>/<m>/<d>/rollout-*-<sessionId>.jsonl` tail에서 `task_complete.last_agent_message` 우선, 없으면 최신 `agent_message`를 읽어 `appendCodexChatEnd`가 `chat_response`를 방출하게 함. Node `codex-rollout-response.ts`와 같은 우선순위.
- D200H Swift direct-HID: live Claude usage가 없을 때 slot 13을 빈 usage 카드로 점유하지 않고 14번째 세션 타일로 재사용. Swift self-daemon/App Store 모드처럼 사용량을 직접 표시할 수 없는 상황에서는 세션 모니터링 공간을 우선한다.
- 회귀 테스트: OTel activity 상태 승격 predicate + rollout reader 우선순위/폴백 케이스 추가. macOS 앱 타깃 빌드 통과. 현재 Xcode project의 노출 scheme에는 테스트 타깃이 포함되지 않아 `-only-testing` XCTest 실행은 scheme 구성상 실패.

---
