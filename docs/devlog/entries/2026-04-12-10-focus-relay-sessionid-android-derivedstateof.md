# 2026-04-12 — Focus relay sessionId 전파 + Android derivedStateOf 수정

### 문제
1. **macOS Dashboard 크리처 중복**: Focus relay가 sibling의 `state_update`를 broadcast하면 client `state.agentType`이 변경되지만 `state.sessionId`는 daemon의 ID로 남아 있음. TerrariumState dedup 필터 `!(primaryIsX && $0.id == sessionId)`가 sessionId 불일치로 실패 → 같은 세션이 primary + sibling 이중 렌더
2. **Android 크리처 미표시**: `MonitorScreen.kt`의 `derivedStateOf { dashState.toTerrariumState() }`가 초기 `dashState` 캡처 후 siblingSessions 변경을 반영하지 않음 (commit 2315206b에서 EinkMonitorScreen만 수정, MonitorScreen 누락)

### 해결
- `StateUpdateEvent`에 `sessionId` 필드 추가 (shared protocol + Swift Protocol.swift)
- Swift daemon `DaemonServer.swift` focus relay broadcast 콜백에서 `focusRelay.focusedSessionId` 주입
- Node.js daemon `daemon-server.ts` focus relay handler에서 동일하게 주입
- Swift `AgentStateHolder.handleStateUpdate()`에서 `state.sessionId` 업데이트
- Android `MonitorScreen.kt`: `remember { derivedStateOf { ... } }` → `remember(dashState) { ... }`

### 핵심 설계 결정
- **sessionId는 state_update에 포함**: focus relay가 promote하는 세션의 ID를 client에 전달. Connection event는 relay하지 않으므로 state_update에 piggyback
- **Unfocus 시 별도 처리 불필요**: daemon이 자체 state broadcast → agentType="daemon" → primaryIsX=false → dedup 미적용 → stale sessionId 무해
- **Android `keepAggregateIdentity` 보호**: Android AgentState.kt의 기존 로직이 focus relay 시 agentType 변경을 이미 차단하므로, Android에서는 duplicate creature 미발생 → Android Protocol.kt에 sessionId 전파 불필요

---
