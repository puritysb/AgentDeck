# 2026-07-12 — Codex 관찰 세션 OTel turnEnd Stop 드리프트 수정

### 변경
- Swift 데몬에서 codex 관찰 세션의 답변이 타임라인에 누락되던 버그를 고쳤다. 직전 턴의 OTel `turnEnd` 스팬이 hook stop보다 늦게(~3s) 도착해, 이미 열린 다음 프롬프트 턴을 빈 payload로 조기 종료(heuristic chat_end·`chat_response` 없음)하고 세션을 finished로 마킹 → 이후 실제 tool·응답이 "Ignored late … for finished session"으로 폐기됐다. 답변은 `~/.codex/sessions` 롤아웃에는 정상 존재.
- `DaemonServer.swift`의 OTel `.turnEnd` 핸들러가 버리던 `turnId`를 살려 세션별 `codexOtelTurnIdBySession` 앵커로 게이트(`shouldCloseOnCodexOtelTurnEnd`): OTel이 서비스 중인 turnId와 일치할 때만 close, hook이 새 턴을 열면(`appendCodexChatStart`) 앵커 무효화, 미확립 상태에서 hook 앵커가 열려 있으면 hook stop / eviction 백스톱에 위임. FIFO/TTL 아닌 turnId 아이덴티티 매칭이라 기존 `ChatTurnAnchorTracker` open-turn 앵커 규칙과 일치.

### 검증
- `xcodebuild build … -scheme AgentDeck_macOS -configuration Debug` — BUILD SUCCEEDED.
- `xcodebuild test … -only-testing:AgentDeckTests_macOS/CodexOtelParserTests` — 42/42 pass (신규 드리프트-가드 4 케이스: 정상매치 close / 이전턴 reject / nil+hook앵커 reject(현장 재현) / 순수 OTel close).
