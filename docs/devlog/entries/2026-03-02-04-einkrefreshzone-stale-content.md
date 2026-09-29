# 2026-03-02 — EinkRefreshZone stale content 버그 수정

### 문제
E-ink 좌측 에이전트 패널에 새 세션이 추가되어도 UI가 업데이트되지 않음. 데이터 파이프라인(Bridge → WS → DashboardState)은 정상이나, `EinkRefreshZone`의 inner `ComposeView`가 stale content를 표시.

### 해결
`EinkRefreshZone.kt`에서 `AndroidView.factory` 안의 `ComposeView.setContent { content() }`가 factory 생성 시점의 `content` 람다를 캡처하여 고정되는 것이 원인. `rememberUpdatedState(content)`로 snapshot-backed State를 만들어 inner ComposeView가 항상 최신 content를 읽도록 수정.

### 교훈 / 핵심 설계 결정
- **AndroidView.factory + ComposeView 패턴**: factory는 1회 실행이므로 캡처한 람다가 고정됨. Compose state를 전달하려면 `rememberUpdatedState`로 간접 참조해야 inner composition도 recompose됨
- Compose snapshot system은 global — 별도 ComposeView의 composition도 같은 State 객체의 변경을 감지

---
