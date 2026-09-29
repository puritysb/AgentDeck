# 2026-07-11 — 타임라인 교차 세션 가짜 서브트리: Swift 컬렉터 per-session 전환 (d22969f0)

### 문제
macOS Dashboard TIMELINE에서 완전히 독립적인 codex/claude 세션들이 한 TASK 헤더 아래 들여쓰기되어 "관련 작업 서브트리"처럼 보였다. 실데이터 검증 결과 태스크 25개 중 12개가 2~6개 세션에 걸쳐 오염. 부수 증상: TASK 헤더가 자기 턴들 **아래**에 렌더링(지연 승격 task_start의 백데이트 ts를 append-only 스토어가 제위치에 못 넣음), task 행의 sessionId가 `hook-N-epoch` 합성 키라 세션 필터에서 헤더 실종, chat_end 전부·codex chat_start의 taskId 미스탬프로 래그드 인덴트.

### 해결
- **근본**: `ApmeCollector.swift`의 데몬 전역 `activeTask`/`activeTurn` 스칼라를 Node `collector.ts`와 동일한 **세션별 맵**(sessionToTurn/Task/LastMilestone/Usage + per-session idle-gap 타이머)으로 전환. 이벤트 귀속 키 = hook payload `session_id`(없으면 최근 세션 폴백). run.sessionId = 실제 세션 UUID → task_start/task_end 행이 세션 필터에 걸림. `activeTaskId(sessionId:)`/`setTurnResponse(sessionId:)`/`closeTaskExternal(sessionId:)` 세션 스코프 API.
- **스탬핑**(`DaemonServer.swift`): claude chat_start/response/end 모두 세션 스코프 스탬프. codex chat_response의 글로벌 taskId 스탬프는 **제거**(codex는 컬렉터 미추적 — 구 스탬프가 오염 그 자체). `setTurnResponse`는 chat_end 행의 sessionId로 라우팅(응답 텍스트 오귀속도 함께 해소).
- **정렬 삽입**: 스토어 4곳(Swift 데몬 `DaemonTimelineStore`/Swift UI `TimelineStore`/SD 플러그인 `timeline-store.ts`/Android `TimelineStore.kt`) live add를 ts 정렬 삽입으로 — 백데이트 task_start가 제위치에 들어감.
- **인덴트 가드**(Swift `timelineRowIsNestedUnderTaskHeader` + Kotlin 미러): 들여쓰기 조건을 "taskId 있음" → "**바로 위 task 마커가 같은 taskId의 task_start일 때만**"으로. 디스크에 남은 레거시 오염 행도 가짜 서브트리로 안 그려짐.

### 핵심 설계 결정
- **컬렉터 상태는 세션이 1급 키** — Node가 원본 설계(`sessionToTask` 맵)였고 Swift 포트가 스칼라로 축약한 것이 회귀 원인. Swift 데몬에 새 세션-연관 상태를 추가할 땐 맵 + payload `session_id` 키가 기본. 미등록 세션의 non-prompt 이벤트는 **드롭**(과거처럼 최근 세션에 오귀속하지 않음) — 게이트웨이 컬렉터는 모든 합성 페이로드에 `"openclaw-gateway"`를 동봉해야 한다.
- **codex 행은 taskId 없음이 정상**: codex는 Swift 컬렉터 미추적이므로 플랫 렌더링. codex용 APME 컬렉터 경로는 별도 후속.
- 재시작 후 실기 검증: 새 run이 실제 UUID로 기록, 이 세션 프롬프트에 자기 태스크 스탬프, codex 행 플랫, 레거시 오염 행 전부 플랫 렌더링(스크린샷 확인).

### 검증
macOS 365 XCTest(신규 동시 2세션 격리 3건 포함) · iOS 빌드 · vitest 1693 · Android testDebugUnitTest 전부 green. 기존 게이트웨이 테스트 1건은 프로덕션 플로우(session_id 항상 동봉)에 맞게 픽스처 수정. 알려진 잔여 한계: 앵커 큐 어긋남(Stop hook 유실 시 응답이 독립 행) — 위 후속 항목(open-turn 트래커 전환)에서 해결.

---
