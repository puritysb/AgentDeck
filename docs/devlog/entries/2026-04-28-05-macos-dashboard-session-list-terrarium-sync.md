# 2026-04-28 — macOS Dashboard session list / terrarium sync 보강

### 문제

macOS Dashboard 에서 focus relay 가 특정 세션의 `state_update` 를 primary state 로 승격하는 순간, 왼쪽 SessionListPanel 은 같은 `agentType` 이 이미 `sessions_list` 에 있으면 primary row 를 숨겼다. 반면 테라리움은 focused `sessionId` 를 primary creature 로 렌더해, 특히 Codex/Claude 세션이 여러 개일 때 목록과 크리처가 순간적으로 어긋날 수 있었다. 또한 Codex row 의 OpenAI knot mark 는 SVG 원본의 `evenodd` fill rule 을 적용하지 않아 내부 홀이 살짝 깨져 보였다.

### 해결

- MonitorScreen 의 테라리움 파생 상태 갱신 키에 focused `sessionId`, `agentType`, project/model, sibling metadata 를 포함해 상태 문자열이나 세션 개수 변화가 없어도 크리처 모델이 즉시 갱신되게 했다.
- SessionListPanel 의 primary row 중복 제거 기준을 `agentType` 에서 `sessionId` 로 좁혀, focus-relayed primary session 과 `sessions_list` 의 동일 row 만 병합한다.
- Codex row OpenAI logo path 렌더링에 `eoFill` 을 적용해 asset catalog 의 `fill-rule="evenodd"` 와 맞췄다.

### 검증

- `git diff --check` 성공
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataDashboardSessionSync CODE_SIGNING_ALLOWED=NO` 성공 (기존 generated `GatewayFrame.JSONNull.hashValue` deprecation warning 은 남음)

---
