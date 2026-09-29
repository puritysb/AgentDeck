# 2026-03-01 — Android 통합 Monitor 화면 (관제탑 리디자인)

### 문제
Android 앱이 테라리움(애니메이션)과 Dashboard(정보 카드)를 별도 탭으로 분리 — "Agent 전체 모습을 한눈에" 관제 역할 불충분. Terrarium Mode 토글로 어느 한쪽만 보여주는 구조.

### 해결
**Phase 1 — 내비게이션 통합**: `Screen.Terrarium` + `Screen.Dashboard` → `Screen.Monitor`. 3탭 구조 (Monitor/Deck/Settings). `terrariumEnabled` 분기 제거, `DisplayPreferences`에서 terrarium 토글 삭제, SettingsScreen에서 토글 UI 제거.

**Phase 2 — HUD 콕핏 (6 신규 파일)**: `ui/monitor/` 디렉토리. `MonitorScreen.kt`(Box: terrarium bg + HUD overlay), `MonitorTopBar.kt`(project+state+mode / model+agent), `ActivityPanel.kt`(tool+input+progress, suggestedPrompt, question), `EnginePanel.kt`(5h/7d gauge+tok+cost+msg+uptime), `MultiAgentPanel.kt`(siblingSessions+workers+OC status), `TimelineStrip.kt`(auto-scroll, typeColor prefix).

**Phase 3 — E-ink 정보량 동등화**: EinkAgentColumn(suggestedPrompt, siblingSessions, workers, sessionStatus), EinkActionColumn(toolInput), EinkEngineColumn(messageCount param), EinkFooterBar(messageCount). Portrait 레이아웃에 terrarium band (~15%) 추가.

**Phase 4 — E-ink 부분 갱신**: `EinkRefreshZone.kt` composable — AndroidView 브릿지로 View 참조 확보, debounced vendor API 호출. `EinkRefreshHelper`에 `requestA2Refresh()`/`requestDURefresh()` 추가 (Onyx BaseDevice + Crema EinkDisplay reflection). Landscape 컬럼별 존 래핑 (Agent=A2/200ms, Action=A2/300ms, Engine=DU/2000ms).

**Phase 5 — 정리**: `DashboardScreen.kt`, `TerrariumScreen.kt` 삭제.

### 교훈 / 핵심 설계 결정
- **ColorTerrariumView 추출**: TerrariumScreen의 60fps 애니메이션 로직을 MonitorScreen 내부 private composable로 이동 — 동일 코드, 새로운 컨텍스트
- **HUD 패널 독립**: 각 패널이 `TerrariumColors.HUDBg` (`0x80000000`) + `RoundedCornerShape(8.dp)` 통일 스타일, `Modifier.align()`으로 Box 내 절대 배치
- **EinkRefreshZone AndroidView 브릿지**: Compose에서는 View 참조를 얻을 수 없어 `AndroidView` > `FrameLayout` > `ComposeView` 래핑으로 해결. View 참조를 `remember`로 보관, `LaunchedEffect(triggerKey)`로 debounced 갱신

---
