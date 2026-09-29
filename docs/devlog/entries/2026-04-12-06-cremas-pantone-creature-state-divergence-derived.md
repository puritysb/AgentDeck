# 2026-04-12 — CremaS/Pantone creature state divergence — derivedStateOf stale closure

### 문제
CremaS와 Pantone6이 같은 daemon에 연결됐지만 CremaS에서 크리처가 0마리(agents=0, clouds=0, oc=0)로 표시되는 반면 Pantone6에서는 정상(agents=1, clouds=1, oc=1). 헤더/사이드바에는 양쪽 모두 세션이 표시됨.

### 해결
`EinkMonitorScreen.kt`의 landscape(line 222)/portrait(line 649) 두 곳에서:
```kotlin
// Bug: derivedStateOf captures the initial parameter value, never re-evaluates
val terrariumState by remember { derivedStateOf { state.toTerrariumState() } }
// Fix: state as key forces recomputation on every change
val terrariumState = remember(state) { state.toTerrariumState() }
```

### 핵심 설계 결정
**Compose `derivedStateOf` + 함수 파라미터 = 스테일 클로저 함정.** `remember { derivedStateOf { param.something() } }`에서 `param`이 함수 파라미터(plain value)면 첫 composition 값에 고착된다. `collectAsState()` 위임 속성은 Compose State로 추적되어 정상 작동하지만, 그 값을 자식 composable에 파라미터로 넘기면 추적이 끊긴다. 해결: `remember(param)` 또는 `rememberUpdatedState`.

**기기 간 차이가 나는 이유는 레이스 컨디션.** `sessions_list`가 `state_update`보다 비동기로 늦게 도착(Promise 기반). 첫 Compose 프레임이 sessions_list 전에 실행되면 빈 siblingSessions 캡처 → 영구 고착. Compose choreographer 타이밍에 따라 기기마다 결과가 달라짐.

---
