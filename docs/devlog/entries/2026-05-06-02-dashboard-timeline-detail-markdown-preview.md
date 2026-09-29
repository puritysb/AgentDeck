# 2026-05-06 — Dashboard TIMELINE detail markdown preview

### 문제

TIMELINE detail pane 이 assistant/eval detail 의 markdown 문법(`**bold**`, list, heading, inline code 등)을
원문 문자열로 그대로 보여 preview 로 읽기 어려웠다.

### 해결

- macOS Dashboard `TimelineStripView` 의 detail text 렌더링을 `AttributedString(markdown:)` 기반
  `TimelineMarkdownPreview` 로 교체했다.
- markdown parse 실패 시 원문 `AttributedString` 으로 fallback 한다. detail pane 의 선택/복사는 유지했다.

### 검증

- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataTimelineMarkdown CODE_SIGNING_ALLOWED=NO` 성공.
- `git diff --check` 성공.

---
