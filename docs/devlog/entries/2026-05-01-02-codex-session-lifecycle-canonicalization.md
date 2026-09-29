# 2026-05-01 — Codex session lifecycle canonicalization

### 문제

이전 보완은 Terrarium/Pixoo 렌더 계층에서 Codex companion thread 를 접고, terminal event 이후 TTL 을 줄이는 방식이었다. 하지만 여전히 근본 경계가 남아 있었다.

- `sessions_list` 자체는 raw Codex thread 를 그대로 내보내서 `/status`, D200H, Stream Deck, SessionListPanel 이 서로 다른 세션 수를 볼 수 있었다.
- `codex_stop`/OTel `turnEnd` 이후 늦게 도착한 `codex_tool_start`/`codex_tool_end`/stream span 이 `lastTerminalCodexEventBySession` 을 지우고 `processing` 으로 되살릴 수 있었다.
- 현재 Codex OTel span 이름(`turn/start`, `responses_websocket.stream_request`, `exec_command`, `dispatch_tool_call_with_code_mode_result`) 상당수가 parser 에서 unknown 으로 떨어졌다.
- OTel `session_id` fallback 도 hook 쪽과 달리 짧은 숫자 id 를 durable thread 로 승격할 여지가 있었다.

### 해결

- `DashboardDataRules.foldCodexSessionPayloadsForDisplay()` 를 추가하고 `DaemonServer.buildSessionsListEvent()` 에서 `sessions_list` 생성 직전에 적용했다. 이제 표시 표면은 모두 같은 folded Codex count 를 받는다. 동일 `projectName` 의 Codex rows 는 상태 우선순위(`processing` > `awaiting_*` > `idle`)와 최신 시작 시간을 기준으로 대표 row 하나로 합쳐지고, `groupSize`/`foldedSessionIds` 를 싣는다. 빈 projectName 은 접지 않는다.
- Stream Deck plugin 도 `foldCodexSessionsForDisplay()` 공유 유틸을 사용해 구버전/외부 daemon 이 raw rows 를 보내도 버튼 수가 부풀지 않게 했다.
- terminal stamp 는 새 턴 신호(`codex_session_start`, `codex_user_prompt_submit`, OTel `turnStart`)에서만 해제한다. terminal 이후 늦은 tool hook/OTel tool/activity span 은 무시해 끝난 thread 가 다시 `processing` 으로 살아나지 못하게 했다.
- Codex stale 정책을 분리했다: no-tool processing 30s idle settle, tool-bearing processing 120s idle settle, Codex idle observation 90s eviction, tool-bearing observation 240s eviction, post-terminal 60s eviction.
- OTel parser 가 slash/underscore span 이름을 정규화하고 현재 Codex span 이름과 activity span 을 인식한다. 숫자-only `session_id` 는 hook 과 동일하게 세션 id 로 승격하지 않는다.

### 검증

- `git diff --check` 성공
- `pnpm --filter @agentdeck/shared build` 성공
- `pnpm vitest run plugin/src/__tests__/session-slot-manager.test.ts` 성공 (5 tests)
- `pnpm --filter @agentdeck/shared typecheck` 성공
- `pnpm --filter @agentdeck/plugin typecheck` 성공
- `xcodebuild test -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -destination 'platform=macOS,arch=arm64' -only-testing:AgentDeckTests_macOS/CodexOtelParserTests -only-testing:AgentDeckTests_macOS/ProtocolTests -derivedDataPath /tmp/AgentDeckDerivedDataCodexLifecycle CODE_SIGNING_ALLOWED=NO` 성공 (첫 실행, Xcode test observer 991s 소요)
- 최종 comparator 경계 보정 후 `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataCodexLifecycle CODE_SIGNING_ALLOWED=NO` 성공. 동일 test 재실행은 Xcode test runner 장시간 대기 반복으로 중단.

---
