# 2026-05-10 — Timeline prompt visibility + anonymous Codex OTel noise cleanup

### 문제

Dashboard TIMELINE 이 "의미 있는 턴만 보인다"는 취지는 맞지만, 실제
사용자 prompt row (`chat_start`) 까지 완료 row 뒤에서 사라지는 경우가
있었다. `TimelineStripView.timelineDisplayGroups` 가 later completion 이
있는 모든 `chat_start` 를 숨겼기 때문에, `hello` 같은 짧지만 의도적인
요청은 응답이 정상 도착한 뒤 timeline 에서 직접 보이지 않았다.

동시에 `~/.agentdeck/timeline.json` 에 과거 익명 Codex OTel 세션
(`codex:otel-active`) 의 `tool`, `tool completed`, `exec` 같은 저신호
`tool_exec` 행이 남아 있었다. 이 행들은 durable thread/prompt 없이 단일
익명 세션에 붙어 task 경계 없이 섞였고, 사용자가 "내 요청은 안 보이고
중간 처리 로그만 보인다"고 느끼게 만들었다.

### 해결

- 완료된 턴이라도 `chat_start.raw` 가 실제 사용자 문장이라면 Dashboard
  timeline 에 유지한다. `Prompt sent`, `Codex turn started`, `Connected`,
  `Resumed` 같은 synthetic 시작 row 만 계속 접는다.
- `chat_response` 가 있는 경우 redundant `chat_end` 는 기존처럼 숨겨 한
  턴이 "요청 + 응답" 중심으로 보이게 했다.
- `DaemonTimelineStore` 가 anonymous Codex OTel 의 generic tool rows
  (`tool`, `tool completed`, `unknown`, `exec`, `exec completed`) 를 add/load
  양쪽에서 버리도록 했다. 기존 persisted history 도 앱 재시작 시 필터된다.
- 동일 필터를 Dashboard display path 에도 두어 오래된 history replay 가
  들어와도 UI 에 노출되지 않게 했다.

### 검증

- `git diff --check -- apple/AgentDeck/UI/Monitor/TimelineStripView.swift
  apple/AgentDeck/Daemon/Timeline/DaemonTimelineStore.swift
  apple/AgentDeckTests/TimelineTests.swift` 통과.
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS
  -destination 'platform=macOS,arch=arm64'
  -only-testing:AgentDeckTests_macOS/TimelineTests test
  CODE_SIGNING_ALLOWED=NO
  -derivedDataPath /tmp/AgentDeckTimelineInvestigation` 통과 — 22 tests,
  0 failures.

---
