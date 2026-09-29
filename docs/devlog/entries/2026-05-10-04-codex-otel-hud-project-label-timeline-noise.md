# 2026-05-10 — Codex OTel HUD / project label / timeline noise 정리

### 문제

Codex App / app-server OTLP batch 가 durable `thread.id` 없이 trace-backed
span 만 보내는 경로에서 Dashboard 는 `codex:otel-active` 익명 세션을 만들었다.
이 세션은 cwd 도 비어 있어 좌측 HUD 프로젝트명이 빈 문자열로 보였고, 같은
OTel batch 의 내부 `tool_call` / `tool_result` span 이 그대로 TIMELINE 에
`tool`, `tool completed` 같은 저품질 로그로 노출됐다. 또한 좌측 HUD 행은
asset catalog SVG template 렌더링을 16pt 슬롯에 직접 써 Codex compact glyph
가 깨져 보일 수 있었다.

### 해결

- 좌측 HUD agent glyph 를 asset renderer 대신 `AgentBrandIcon` path renderer
  로 통일하고, Codex path 를 canonical `design/brand/codex.svg` 와 맞췄다.
- Codex OTel cwd alias 를 `process.cwd`, `terminal.cwd`, `workspace.root`,
  `project.root` 등으로 확장했다.
- 익명 `codex:otel-active` 세션은 cwd 가 없을 때 현재 visible session 들의
  non-Codex 프로젝트명이 하나로 수렴하면 그 이름을 fallback 으로 채운다.
  그래도 알 수 없으면 HUD 표시는 `Codex` 로 fallback 해서 빈 라벨을 피한다.
- OTel tool spans 는 타임라인에 쓰지 않고 세션 state/currentTool 갱신에만
  사용한다. Codex timeline 은 실제 prompt/response payload 가 있는 lifecycle
  hook 에서만 기록한다.
- `tool` / `unknown` 처럼 의미 없는 Codex tool name 은 hook path 에서도
  timeline entry 로 만들지 않는다.

### 검증

- `git diff --check -- apple/AgentDeck/UI/Common/SessionBrand.swift
  apple/AgentDeck/UI/Monitor/SessionListPanel.swift
  apple/AgentDeck/Daemon/Modules/CodexTelemetryModule.swift
  apple/AgentDeck/Daemon/Server/DaemonServer.swift
  apple/AgentDeckTests/CodexOtelParserTests.swift`
  통과.
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS
  -destination 'platform=macOS'
  -only-testing:AgentDeckTests_macOS/CodexOtelParserTests
  -only-testing:AgentDeckTests_macOS/ProtocolTests test
  EXCLUDED_SOURCE_FILE_NAMES=LaunchSessionDialog.swift CODE_SIGNING_ALLOWED=NO
  -derivedDataPath /tmp/AgentDeckCodexHudTimelineFix`
  통과 — 52 tests, 0 failures.

---
