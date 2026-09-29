# 2026-03-02 — Android 에이전트 상태 업데이트 지연 + E-ink 크리처 개선

### 문제
1. **세션 추가/종료 시 Android 반영 최대 30초 지연**: Bridge `sessions_list` 30초 폴링만 사용
2. **E-ink 크리처 반영 안됨**: RefreshZone triggerKey가 `siblingSessions.size`만 감시 — 상태 변경 무시
3. **E-ink 크리처 위치 비정상**: IDLE octopus가 0.42f(수중)에 떠있음 — 바닥에 있어야 함
4. **E-ink 크리처 흑백만 표시**: 모든 부위가 `GRAY_CREATURE=0x222222` 단일 색상

### 해결

**Bridge (sessions_list 즉시성)**:
- `state_changed` 이벤트 시 `sessions_list`도 2초 debounce로 즉시 broadcast
- 폴링 주기 30초 → 10초 단축
- **TDZ 함정**: `let` 변수를 `state_changed` 핸들러보다 뒤에 선언하면 핸들러 실행 시 `ReferenceError`. `let`의 Temporal Dead Zone은 `var`와 달리 선언 전 접근 불가

**Android (E-ink 리프레시)**:
- Agent panel triggerKey: `siblingSessions.size` → `sessionsKey` (id:state join 문자열)
- Aquarium triggerKey: `agentState` → `Pair(agentState, sessionsKey)`
- EinkTerrariumView LaunchedEffect: `agents.size` → `agentsKey` (visualState 리스트)
- `toTerrariumState()` → `derivedStateOf` 적용 (불필요한 recomposition 방지)

**E-ink 크리처 Y-position** (color renderer 일치):
- Octopus: SLEEPING=0.78(바닥), FLOATING=0.66(모래 위), WORKING=0.42(수영), ASKING=0.60
- Crayfish: DORMANT=0.82, SITTING=0.72(바위 위), ROUTING=0.55(떠오름), OBSERVING=0.62

**E-ink 그레이스케일**:
- 부위별 분리: body(0x44), limb/claw(0x33), eyes(black/white)
- SLEEPING 감쇠: body→seaweed(0x55), limb→gravel(0x66)
- WORKING starburst: 8방사 그레이(0x99) 글로우
- Crayfish 분리: body(0x44), claw(0x33, 더 진함)

### 교훈 / 핵심 설계 결정
- `let`/`const` TDZ: 이벤트 핸들러에서 참조하는 변수는 반드시 핸들러 등록 전에 선언
- E-ink RefreshZone triggerKey는 **내용 기반 키**(상태 문자열 join)를 사용해야 실제 변경 감지 가능
- E-ink 크리처 Y-position은 color renderer와 동일한 "바닥=대기, 부상=활동" 패턴 유지

---
