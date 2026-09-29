# 2026-04-28 — Codex observation stale active state 정리

### 문제

Codex lifecycle hook / OTel 로 합성된 세션이 실제 활성 상태가 아닌데도 메뉴바와 D200H 에 `WORKING` 처럼 남는 현상이 있었다. `/status.sessions` 는 registry 기반이라 daemon 하나만 보이지만, D200H 는 `sessions_list` 캐시를 렌더해 서로 다른 상태처럼 보였다.

### 해결

- Codex 합성 세션(`codex:<thread-id>`)이 `processing` 이면서 `currentTool` 이 없는 상태로 30초 이상 새 progress 를 받지 않으면 자동으로 `idle` 로 강등한다. `codex_stop` / `codex_turn_complete` / OTel `turnEnd` 누락 시에도 메뉴바 아이콘과 디바이스가 stale active 상태를 오래 유지하지 않는다.
- TTL 로 제거된 Codex row 는 late `codex_tool_end`, `codex_stop`, notify completion 이벤트로 재생성하지 않는다. 재생성은 `codex_session_start` 또는 `codex_user_prompt_submit` 만 허용 (2026-05-01 갱신: `codex_tool_start` 부활 제거 — leftover hook 으로 phantom 재합성 사례. `codex_user_prompt_submit` 은 인터랙티브 Codex 가 post-terminal TTL 로 evict 된 뒤 다음 프롬프트로 복귀하는 경로라 유지). 자세한 배경은 본 로그의 2026-05-01 항목 참조.
- `/status` 는 registry-only `sessions` 대신 실제 디바이스/대시보드가 받는 `sessions_list` 기반 세션을 반환하고, 기존 파일 registry 값은 `registrySessions` 로 별도 노출한다.

### 검증

- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataCodexStaleFix CODE_SIGNING_ALLOWED=NO` 성공

---
