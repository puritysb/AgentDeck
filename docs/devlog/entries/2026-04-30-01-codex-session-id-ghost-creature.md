# 2026-04-30 — Codex 숫자 session_id ghost creature 차단

### 문제

macOS daemon 의 `/status.sessions` 에 실제 사용자-facing Codex thread 와 별개로 `codex:8`, `codex:5`, `codex:2` 같은 짧은 숫자형 Codex 세션이 합성됐다. 이 항목들은 `projectName` 이 비어 있어 Dashboard / D200H 에 이름 없는 Codex 크리처처럼 보였고, 실제 활성 Codex 세션 수와 화면에 노출되는 크리처 수가 맞지 않았다.

### 해결

- Codex hook identity 해석을 `CodexHookIdentity` 로 분리했다.
- `thread-id` / `thread_id` / `threadId` / `codex.thread_id` / `thread.id` 를 최우선으로 사용한다.
- `session_id` fallback 은 12자 미만 또는 숫자-only 값이면 durable thread id 로 보지 않고 무시한다. 따라서 turn/tool/companion 단위로 보이는 `session_id: "8"` 같은 payload 는 `codex:8` 세션으로 승격되지 않는다.
- 회귀 방지 테스트를 추가해 thread id 우선순위, 숫자형 fallback 거부, UUID형 fallback 허용을 고정했다.

### 검증

- `git diff --check` 성공
- `xcodebuild test -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -destination 'platform=macOS,arch=arm64' -only-testing:AgentDeckTests_macOS/CodexOtelParserTests -derivedDataPath /tmp/AgentDeckDerivedDataCodexIdentity CODE_SIGNING_ALLOWED=NO` 성공

---
