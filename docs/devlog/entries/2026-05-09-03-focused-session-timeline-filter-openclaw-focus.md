# 2026-05-09 — Focused session timeline filter + OpenClaw focus

### 문제

Dashboard 에서 특정 세션을 focus 해도 하단 `TIMELINE` 은 전체 세션 이벤트를
계속 섞어서 보여줬다. 동시에 OpenClaw crayfish 는 hit-test 결과가
`crayfish` sentinel 로 돌아오고 `MonitorScreen` 이 이를 무시해서, 좌측
HUD row 와 달리 terrarium 에서는 선택할 수 없었다.

### 해결

- `TimelineStripView` 가 `DashboardState.focusedSessionId` 를 읽어 해당
  세션의 timeline entry 만 필터링하도록 했다. 우선 `sessionId` 를 쓰고,
  legacy entry 는 `projectName + agentType` fallback 으로 매칭한다.
- OpenClaw virtual Gateway session (`openclaw-gateway`) 은 daemon-local
  session 으로 취급한다. crayfish tap 이 이 id 로 focus 하고, Swift/Node
  daemon 모두 relay WS 연결 없이 `focusedSessionId` 를 broadcast 한다.
- Terrarium focus halo 가 `openclaw-gateway` focus 를 crayfish 위치에
  그리도록 확장했다.

---
