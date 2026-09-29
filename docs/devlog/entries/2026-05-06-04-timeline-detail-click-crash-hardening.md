# 2026-05-06 — TIMELINE detail click crash hardening

### 문제

macOS Dashboard 에서 TIMELINE event 를 클릭해 detail pane 이 뜨기 직전에 `EXC_BREAKPOINT` 가 발생하는
재현 신호가 있었다. 직전 변경에서 detail text 를 `AttributedString(markdown:)` 기반 rich preview 로
바꿨는데, TIMELINE detail 은 agent 응답, tool JSON, table-like markdown, emoji, 로그 조각 같은 임의
문자열을 그대로 받는다. `try?` 는 parse error 만 fallback 할 뿐 Markdown parser 내부 assertion/trap 은
막지 못하므로 UI click path 에 시스템 Markdown parser 를 두는 것은 안전하지 않다.

### 해결

- `TimelineMarkdownPreview` 에서 `AttributedString(markdown:)` 호출을 제거했다.
- headings/list/numbered list/quote/fenced code 정도만 직접 분류하는 line-based safe renderer 로 교체했다.
- 별도로 Xcode 가 지목한 `DaemonServer.effectiveOauthConnected()` 경로는 ESP32 serial heartbeat callback 이
  `@MainActor` 서버 상태를 background actor 에서 읽을 수 있던 문제라서, serial-facing state/usage/display
  event 를 lock-protected snapshot 으로 전달하도록 분리했다.

### 검증

- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataTimelineMarkdownCrash CODE_SIGNING_ALLOWED=NO` 성공.
- 실행 중인 Dashboard 에서 TIMELINE row 를 여러 번 클릭해 detail pane 전환이 계속 동작하는 것을 확인했다.
- `git diff --check` 성공.

---
