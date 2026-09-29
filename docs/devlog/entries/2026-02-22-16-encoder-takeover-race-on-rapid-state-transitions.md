# 2026-02-22 — Encoder Takeover Race on Rapid State Transitions

### 문제
Quick Action에서 옵션 선택 후 즉시 PERMISSION 프롬프트(Allow Bash 등)가 뜨면 다이얼이 응답하지 않음. AWAITING_OPTION → select_option → PROCESSING → AWAITING_PERMISSION 전환이 빠르게 연속 발생.

### 해결
`exitEncoderTakeover()`는 `active=false`를 동기로 설정하고 `setFeedbackLayout('voice-layout.json')`을 async로 실행. 곧바로 `enterEncoderTakeover()`가 `active=true` + `setFeedbackLayout('option-pixmap-layout.json')` 실행. exit의 `.then()` 콜백(다이얼 상태 복원)이 enter 이후에 resolve되면서 takeover 레이아웃을 voice 레이아웃으로 덮어씀.

`plugin.ts`에 `takeoverGeneration` 카운터를 도입하여 exit/enter `.then()` 콜백 실행 시 generation이 변경되었으면 콜백을 스킵.

### 교훈
async takeover 전환에서 `.then()` 콜백은 항상 generation guard 필요. `active` 플래그만으로는 비동기 완료 콜백의 순서를 보장할 수 없음.

---
