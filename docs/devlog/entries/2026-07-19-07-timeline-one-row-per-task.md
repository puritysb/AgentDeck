# 2026-07-19 — TIMELINE 태스크 행 구조 개편: one-row-per-task 렌더 계약

### 문제

대시보드 TIMELINE 의 TASK END 행이 의미 있는 정보를 주는지 점검한 결과, 노이즈와 신호가 정확히 뒤집혀 있었다. Swift 데몬 스토어 최근 24시간 실측: task_end 30건 중 26건이 **리퍼 합성 `interrupted` 행**("Interrupted · ~6h 33m") — 데몬 재시작 아티팩트라 judge 가 영원히 돌지 않아 score/summary 가 없는데 **화면에는 보였고**, 유일하게 eval payload 를 가진 `session_end` 4건은 "내부 샘플 경계" 명목으로 **숨겨져 있었다**. 짝인 task_start 헤더도 전부 bare "Task 1" 이라 meaningful-title 게이트에서 탈락 — 사용자가 보는 것은 헤더 없는 고아 "TASK END — Interrupted" 뿐이었다. `/task close`(manual)·`/clear` 명시 경계는 실사용 0건.

### 해결 — 렌더 계약을 데이터 계약에서 분리

`task_start`/`task_end` 쌍은 **데이터 계층에 그대로 유지** (스피너 정지 신호, judge 결과 upsert 매개체, orphan reaper 합성 대상 — 와이어/스토어/업서트 무변경). 바뀐 것은 렌더 계약 하나: **태스크당 헤더 한 행**, closure 는 헤더에 접혀 들어간다.

- **SSOT 신설**: `shared/src/timeline-task-display.ts` — `timelineShouldRenderTaskRow` (task_end 는 무조건 비표시; 헤더는 meaningful title ∨ eval payload(자신∨closure)), `timelineTaskClosure`, `timelineTaskHeaderDisplay` (judge 요약이 "Task N" 제목 대체, closure 라벨 칩, 배지 필드). vitest 커버.
- **Swift** (`TimelineStripView.swift`): `taskHeaderRow` 가 closure 를 접어 렌더, detail pane 의 eval verdict 도 헤더 선택 기준으로 전환. ★함정: closure 조회와 스피너 판정의 siblings 를 display-filter 이전 `filteredEntries` 로 — `grouped` 를 쓰면 task_end 가 필터에서 빠져 닫힌 태스크가 영원히 스핀한다.
- **Android** (`TimelineDisplay.kt` + `TimelineStrip.kt`): 동일 미러. eink 패널들은 `timelineDisplayGroups` 공유라 자동 커버.
- **글랜스 표면은 task 행 자체를 제외**: 양 데몬의 lastEventText milestone 선정(`BridgeCore.attachLastEventFields` / `DaemonServer.cardMilestoneTypes`)과 ESP32 펌웨어 milestone/ticker 집합(`eink_display.cpp`, `hud_bar.cpp`) 에서 task_start/task_end 제거. task_start 라벨의 turn-row 컨텍스트 해석은 유지.
- **TUI** (`renderer.ts`): task_end 필터 + eval suffix 를 헤더로 이동.

결과: 리퍼 `interrupted` 쌍은 아무 행도 남기지 않고, judge 된 태스크(기존에 숨겨지던 session_end 포함)는 요약을 제목으로 단 헤더 한 행 + 배지로 표시된다.

### 검증

vitest 1908 전건 green (신규 timeline-task-display 테스트 포함) · Swift `TimelineTests` 71건 green (신규 3건: standalone task_end 비표시 / judged 단일 헤더 / interrupted 쌍 비표시) · Android `testDebugUnitTest` green (기존 "manual boundary visible" 테스트를 새 계약으로 개정) · `pio run -e inkdeck -e ips35` SUCCESS. 실기기 대시보드 반영은 다음 앱/데몬 재시작 시.
