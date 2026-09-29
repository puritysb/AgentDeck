# 2026-03-02 — E-ink & 태블릿 디스플레이 통합 + OpenClaw 애니메이션

### 문제
1. **태블릿 멀티세션**: `LaunchedEffect(state.agents.size)`가 에이전트 수 변경 시에만 재실행 — 세션 교체/이름 변경/상태 변경 반영 안 됨
2. **E-ink 말풍선/이름태그**: WORKING 상태에서 말풍선이 캔버스 상단 밖으로 나갈 수 있음
3. **올라마 상태 간헐적**: `ollamaStatus`가 `state_update`에만 포함되어 5초 polling에도 `usage_update`에는 누락
4. **OpenClaw 애니메이션**: PROCESSING 시 가재만 ROUTING, 물고기(테트라)는 CIRCLING 유지 — `hasTool` 항상 false (OpenClaw adapter가 `currentTool` 미설정)
5. **가재-물고기 상호작용 없음**: food crumb이 WORKING 옥토퍼스에서만 산란, OpenClaw primary면 옥토퍼스 없어서 물고기에 먹이 공급 안 됨

### 해결
- **`LaunchedEffect(state.agents)`**: 리스트 참조 변경 시마다 트리거 — add/remove + 전체 creature homePosition/state/mark/displayName 갱신
- **Y 클램프**: `bubbleY.coerceAtLeast(bubbleR + 2f)`, `tagTop.coerceAtLeast(2f)` — 캔버스 밖 방지
- **이름태그 가시성**: 폰트 `0.018f→0.024f`, 태그 너비 `0.14f→0.16f*1.8f`, 1px GRAY_OCTO_LIMB 테두리
- **올라마 piggyback**: `buildUsageEvent()`에 `ollamaStatus` 파라미터 추가 → 모든 `usage_update`에 포함
- **TankStatusPanel → DashboardState**: 5개 개별 파라미터 → 단일 DashboardState (e-ink 패턴 통일)
- **E-ink Status 2-section**: TOKENS & COST 제거 → Rate Limits + Models 2-column Row
- **OpenClaw 테트라 STREAMING**: `crayfishRouting` flag 도입 — 가재 ROUTING 시 IDLE/PROCESSING 모두 → STREAMING
- **가재 heartbeat**: SITTING 상태에 4초 주기 더블펄스 teal glow 추가 — 생존 신호
- **가재 위치 추적**: `CrayfishCreature.currentPosition()` + `isRouting()` API 추가
- **DataParticleSystem 가재 인식**: `setCrayfishState(position, routing)` — ROUTING 가재에서 food crumb 산란 + school center 30% 인력
- **E-ink 테트라 가재 타겟**: 옥토퍼스 없을 때 가재 위치(0.75, 0.55)로 STREAMING pull + 데이터 파티클 orbit

### 교훈 / 핵심 설계 결정
- **이벤트 piggyback 패턴**: 정기 폴링 데이터(ollamaStatus)는 별도 이벤트보다 기존 주기적 이벤트(usage_update)에 piggyback하는 것이 효율적 + 클라이언트 코드 단순
- **크리처 간 상호작용**: 가재-물고기처럼 서로 다른 크리처 시스템 간 연동은 중간 데이터 계층(DataParticleSystem)에 위치/상태를 주입하는 pull 모델이 깔끔 — 각 크리처는 자신의 렌더링만 책임, 상호작용은 데이터 계층이 조율
- **LaunchedEffect 키 선택**: `.size`가 아닌 리스트 자체를 키로 — data class 기반 리스트는 내용 변경 시 참조가 바뀌므로 정확하게 트리거

---
