# 2026-09-12 — 손 미러가 조용히 갈라졌다: Android 타임라인 아이콘 두 건 (#312)

"Task 앞 체크리스트가 왜 돌지?"라는 질문에서 출발해 두 건이 나왔다. 둘 다 **TS와 Swift 에는 이미
있던 수정이 Android 미러에만 없던 것**이다.

### 1. 회전하는 체크리스트

`task_start` 는 짝이 되는 `task_end` 가 오기 전까지 선행 아이콘을 돌린다 — 이건 의도다. 그런데
Android 는 `TimelineIconKey.Task`(Material `Checklist`) 를 **그대로** 돌려서, 정사각 글리프가 제자리
회전하며 스피너가 아니라 고장처럼 보였다. Apple 은 이미
`RotatingTimelineIcon(rotatingSymbolName:)` 로 회전 중에만 원형 화살표를 끼워 넣고 멈추면 의미
글리프로 돌아온다 — 주석에 "a square glyph spinning on its centre reads as a glitch" 라고 이유까지
적혀 있었다.

규칙을 SSOT 로 올렸다: [`shared/src/timeline-icons.ts`](shared/src/timeline-icons.ts) 의
`TIMELINE_ROTATING_ICON_KEY` 와 `timelineDisplayIconKey()` — **도는 것은 무엇이든 `running` 화살표를
그리고 멈추면 자기 키로 돌아온다.** `task` 외에는 회전 행이 이미 `running` 이라 눈에 보이는 변화는
그 하나뿐이다.

**작업 중 피한 함정:** 일반 행의 회전 조건은 `!isFolded && !isCompletedTurn && isRotatingEntry(...)`
다. 거기서 예측자를 다시 계산해 글리프를 바꾸면 **돌지도 않는데 화살표가 정지 상태로 박히는** 새
버그가 된다. 두 렌더 지점 모두 그 행의 실제 회전 조건에 물렸다. `contentDescription` 은 의미값을
유지한다 — 회전은 장식이다.

### 2. 완료 목록에서 빠진 `error`

Kotlin `isRotatingEntry` 의 완료 판정이 `chat_response || chat_end || model_response` 뿐이었다.
TS·Swift 는 `error` 를 포함하고 주석도 같다 — 실패한 요청은 답변 대신 `error` 를 내므로, 빼두면
**그 에러를 설명하는 행 옆에서 스피너가 계속 돈다.** 결정적으로 같은 Kotlin 파일의
`turnHasLaterCompletion` 에는 `error` 가 들어 있었다. 한 함수에만 누락된, 포팅 누수다.

### 왜 게이트가 못 잡았나

`shared/src/timeline-icons.ts` 는 3중 **손 미러**(Apple `TimelineStripView.swift`, Android
`TimelineIcons.kt`)인데 드리프트 게이트가 없고 표면별 병렬 테스트만 있었다. 그리고 어디에도 부채로
적혀 있지 않았다.

**핵심: 표면별 병렬 테스트는 모든 표면의 테스트에 똑같이 없는 누락을 못 잡는다.** 각 표면이 자기
구현을 자기 테스트로만 검증하면, 한 표면이 받지 못한 수정은 그 표면의 테스트에도 없으므로 전부
초록으로 통과한다. 생성된 미러 + 바이트 게이트였다면 애초에 갈라질 수 없었다.
[docs/architecture.md](docs/architecture.md) 의 Known hand-mirror debt 에 이번 divergence 를 증거로
기록하고 다음에 건드릴 때 생성기로 접도록 표시했다.

### 검증

두 회귀 테스트가 **수정 없이 실제로 실패하는지 확인**했다 — swap 을 끄면
`a rotating row draws the running glyph, not its own` 실패, `error` 를 빼면
`an error closes a turn so the spinner stops beside its explanation` 실패. 복구 후
`TimelineTaskHierarchyTest` 44개 전부 통과. Node 286파일 4,457 passed/1 skipped, 프로토콜 재생성
무변경, 토큰 미러 동기, docs 검사 통과. 머지 후 master 는 CI·Android·Apple·Design System·Pages 전부 green.
