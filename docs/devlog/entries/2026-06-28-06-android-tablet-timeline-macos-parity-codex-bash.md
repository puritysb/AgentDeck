# 2026-06-28 — Android tablet TIMELINE macOS parity: Codex Bash firehose 제거 + daemon history 복원

### 문제
Android tablet TIMELINE 이 macOS Dashboard 와 다르게 Codex `tool_exec` row(`Bash: ...`, `Bash completed: ...`, `apply_patch ...`)를 그대로 보여줘 실제 사용자-facing 활동 단위(chat/task)를 밀어냈다. 또한 Node CLI daemon 재시작 뒤 새로 연결한 Android tablet 은 `BridgeTimelineStore` 메모리 buffer 가 비어 있으면 디스크 `~/.agentdeck/timeline.json` 에 최근 활동이 있어도 `timeline_history`를 받지 못해 `No timeline events` 로 보였다.

### 해결
- Android `TimelineDisplay.kt` low-signal filter 를 Apple/Shared 정책과 맞춰 Codex `tool_exec` 를 전부 device timeline storage/display 에서 제거. APME/내부 trajectory 는 별도 경로로 유지하고, tablet 은 Codex chat/task lifecycle row 만 표시.
- Node `BridgeTimelineStore` 에 persisted `timeline.json` rehydrate 경로를 추가. daemon 시작 시 후보 data dir 의 최신 `timeline.json` 을 listener broadcast 없이 메모리 replay buffer 로 로드하고, 같은 storage normalization 으로 Codex tool firehose 는 복원하지 않는다.
- 회귀 테스트: Android `TimelineStoreTest` 에 일반 `codex:<uuid>` Bash row drop 케이스 추가, bridge `timeline-integration.test.ts` 에 persisted history load + Codex tool_exec 제거 케이스 추가.

### 검증
- Android `./gradlew :app:testDebugUnitTest --tests dev.agentdeck.state.TimelineStoreTest --tests dev.agentdeck.net.ProtocolTest --no-daemon` 성공.
- `pnpm vitest run bridge/src/__tests__/timeline-integration.test.ts shared/src/__tests__/timeline.test.ts` 성공 — 2 files / 100 tests.

---
