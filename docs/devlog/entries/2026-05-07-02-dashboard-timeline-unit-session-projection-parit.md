# 2026-05-07 — Dashboard Timeline unit-session projection parity

### 문제

Dashboard Timeline 이 플랫폼별로 다른 단위를 보여줄 수 있었다. Apple Dashboard 는
`chat_start` 를 진행 중 row 로만 남기고 완료 후에는 `chat_response` / `chat_end`
중 의미 있는 완료 row 를 보여주는 projection 을 갖고 있었지만, Android tablet/e-ink
는 raw event 를 거의 그대로 그룹화했다. 특히 `tool_request` / `chat_end` 를 타입만
보고 묶어 서로 다른 세션이나 프로젝트의 이벤트가 같은 시간대에 합쳐질 수 있었다.

### 해결

- Android 공통 `TimelineDisplay.kt` projection 을 추가했다.
  - in-flight `chat_start` 는 같은 session/project completion 이 생기기 전까지만 표시.
  - `chat_response` 가 같은 turn 을 대표하면 중복 `chat_end` 는 숨김.
  - `runId → sessionId → projectName+agentType` 순으로 timeline context 를 매칭.
  - lifecycle bounds(start/end/duration)는 `startedAt`/`endedAt` 또는 paired
    `chat_start` 로 계산.
- Android `groupConsecutive` 는 이제 같은 context 일 때만 `tool_request` /
  `chat_end` 를 묶는다. Claude/Codex/OpenClaw/OpenCode 가 동시에 일해도 row 가
  섞이지 않는다.
- Android tablet `TimelineStrip` 과 e-ink `EinkEventLog` / `EinkTimelinePanel` 이
  같은 projection 을 사용한다.
- Android tablet row 에 `BrandIcon` 을 추가해 Claude/Codex/OpenClaw/OpenCode
  캐릭터/브랜드 자산이 project prefix 와 함께 보이게 했다.
- Apple Timeline detail pane 도 row 와 동일하게 `project · agent` 출처를 보여준다.

### 검증

- `./gradlew :app:testDebugUnitTest --tests dev.agentdeck.state.TimelineStoreTest --tests dev.agentdeck.state.TimelineDisplayScenarioTest --tests dev.agentdeck.net.ProtocolTest --no-daemon` 성공.
- `./gradlew :app:compileDebugKotlin --rerun-tasks --no-daemon` 성공. Kotlin daemon
  cache 오류 후 daemon-less fallback 으로 정상 컴파일됨.
- `./gradlew :app:testDebugUnitTest --rerun-tasks --no-daemon` 성공.
- `bash scripts/build-android-release.sh` 성공 → `dist/agentdeck-v0.4.1.apk` 생성.
- `pnpm vitest run shared/src/__tests__/timeline.test.ts bridge/src/__tests__/apme-task-boundary.test.ts bridge/src/__tests__/apme-telemetry-envelope.test.ts` 성공 — 3 files / 93 tests.
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataTimelineEval CODE_SIGNING_ALLOWED=NO` 성공.
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_iOS -configuration Debug -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M4),OS=18.6' -derivedDataPath /tmp/AgentDeckDerivedDataTimelineEvalIOS CODE_SIGNING_ALLOWED=NO` 성공.
- `git diff --check` 성공.

---
