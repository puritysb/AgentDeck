# 2026-05-17 — Apple Daemon: Timeline turn merge + chat_start ts FIFO queue + APME outcome 영구화 + OpenClaw 도구 가시성

### 문제

세 가지 문제가 한 세션에서 누적 발견됐다.

1. **Timeline UX**: 한 user prompt → 응답 → 완료 사이클이 3 row 로 쪼개져 보이고, task_start 회전 spinner 가 영원히 돌며, TASK 헤더가 모든 첫 메시지마다 등장. 회전 아이콘은 사각형(`list.bullet.rectangle.fill`)이라 회전이 어색.
2. **OpenClaw 도구 가시성**: `apme.sqlite` 의 OpenClaw `tool_name` 컬럼이 `"tool"` placeholder, payload 도 비어서 도구 호출이 무엇이었는지 추적 불가. APME run 들이 일괄 `task_category='_empty'` 로 분류돼 평가 무의미.
3. **APME outcome 영구화 silent drop**: `ApmeOutcomeEngine.evaluateOutcome` 의 결과 4 fields (outcome / outcomeConfidence / efficiencyJson / compositeScore) 가 DB 에 영구화되지 않아 같은 6 run ID 가 30 초마다 217 회 재로깅. 전체 DB 에 outcome 컬럼이 채워진 run 이 0 건.

### 해결

**Timeline UX (Apple)**
- `Model/Timeline.swift::groupConsecutive` 에 chat-turn merge 분기 추가 — 같은 sessionId 의 chat_start (meaningful) → chat_response → chat_end 를 `GroupedEntry.mergedResponse` / `mergedCompletion` 로 흡수해 1 row 로 표시. wall-clock window 안 보고 `child.startedAt == start.ts` anchor 매칭으로 cross-turn attach 차단.
- `Daemon/Apme/ApmeCollector.swift`: `openTaskIfNone` 의 timeline emit 을 deferred. TodoWrite 호출 또는 2nd turn 시 `emitDeferredTaskStartIfNeeded()` 가 발화. 단일-turn 짧은 대화는 TASK 헤더 안 보임.
- `ApmeCollector.idleGapSec` (default 90 s) + 4-단 race guard (`attributedToActiveTurn` / `idleGapMinTurnAgeSec` / snapshot turnId / chatEndTs) — `setTurnResponse` 끝에서만 arm.
- `UI/Monitor/TimelineStripView.swift::RotatingTimelineIcon` 에 `rotatingSymbolName` 옵션 — TASK 헤더는 정적 시 `list.bullet.rectangle.fill`, 회전 시 `arrow.triangle.2.circlepath`.

**OpenClaw 도구 가시성**
- `Daemon/Gateway/OpenClawAdapter.swift`: `emitTimelineEntry(fromSessionTool:)` 가 toolName / toolInput / toolOutput 을 out-of-band extras dict 로 노출. `firstJSONValue` 헬퍼가 NSNull (explicit JSON null) 을 absent 로 unwrap.
- `Daemon/Server/DaemonServer.swift::gatewayToolHookFromEntry` 정적 helper — entry dict 에서 구조화 필드 추출 + Claude Code shaped hook payload (`tool_name` / `tool_input` / `tool_response`) 로 매핑. 라우팅은 `status ∈ {complete, error, failed}` 또는 `toolOutput != nil` → tool_end, 그 외 → tool_start. `entry["detail"]` 은 더 이상 routing 결정에 안 쓰임 (legacy fallback 에서 detail blob 으로 running 이 tool_end 로 잘못 분기되던 버그).

**APME outcome 영구화 (Apple)**
- `Daemon/Apme/ApmeStore.swift::updateRun` 의 `colMap` 에 outcome / outcomeConfidence / efficiencyJson / compositeScore 4 entries 추가. 매핑 없는 키는 `guard let col = colMap[key] else { continue }` 에서 silent skip → SET clauses 0 개 → 조기 return → SQL UPDATE 자체 실행 X. 스키마 / readRun / migrations 는 모두 outcome 알고 있는데 updateRun 하나만 빠진 silent partial wiring. 헤더 주석으로 future-proofing 명시.

**chat_start ts FIFO queue (Apple)**
- `Daemon/Server/DaemonServer.swift`: `claudeChatStartTsBySession: [String: Double]` / `codexChatStartTsBySession` 단일-슬롯 dict → file-scope `ChatStartTsQueue` 구조체 인스턴스 2 개. chat_start = enqueue, Stop hook = dequeue head (FIFO). mid-turn 행위 (tool_exec 등) 는 `peekTail` (가장 최근 = active turn). `appendCodexChatStart` 의 upsert 분기 제거 — follow-up prompt 의 head row overwrite 차단.

### 핵심 설계 결정

- **single-slot per-session state 는 multi-turn race 에 취약**. `[String: T]` slot 이 "현재 active turn 의 T" 라는 가정은 사용자의 빠른 follow-up + 비동기 Stop hook callback 조합에서 깨진다. 모든 in-flight turn state 는 sessionId 안에서 FIFO queue (또는 turn-id keyed dict) 로 추적해야. `ChatStartTsQueue.peek` (head, "다음 Stop 이 dequeue 할 것") vs `peekTail` (newest, "지금 generating 중인 turn") 시맨틱 분리.
- **chat_response / chat_end 의 `startedAt` 는 source-of-truth anchor**. Daemon 이 originating chat_start 의 ts 를 stamp 하고, Timeline `groupConsecutive` 의 `sameTurnAnchor(start:, child:)` 가 그 anchor 와 head 의 ts 가 일치할 때만 흡수. wall-clock window 는 dedup 그룹화에만 (60 s), turn merge 에는 무관 — 긴 응답 (xcodebuild + 멀티 fix 20 분+) 을 한 turn 으로 묶기 위해.
- **Tool routing 은 status / output 기반 strict**. `entry["detail"]` 처럼 시각용 blob 의 nil 여부로 start vs end 를 결정하면 input-only running 이 end 로 잘못 분기. routing 전용 helper (`gatewayToolHookFromEntry`) 를 testable 한 static 으로 분리.
- **colMap 같은 single-source mapping table 은 silent-failure 위험**. 키 누락이 컴파일 에러 없이 SQL UPDATE 자체를 무력화. 헤더에 "extending 시 mirror 위치" 명시 + 회귀 가드 (round-trip 테스트) 필수.
- **NSNull defense in depth**: JSON-decoded `[String: Any]` 의 explicit `null` 은 `Optional.some(NSNull())`. `!= nil` 통과. producer / router 양쪽에서 unwrap.
- **spinner stop 은 chat_end 가 아닌 "응답 도착" 신호 기반**. chat_end 는 비신뢰성 path (Stop hook ~18% reliability + async summarize). chat_response 는 sync broadcast 라 더 신뢰성 있음. `GroupedEntry.hasResponse` = `mergedResponse != nil || mergedCompletion != nil` 둘 중 하나라도 도착하면 turn "delivered". chat_end 누락에도 spinner 정상 종료.

회귀 가드 33+ 종 신규 (TimelineTests + ApmeTaskBoundaryTests). Codex stop-time review 11 차에 걸쳐 누적 발견된 race / mis-routing / hang-induced-spinner 시나리오를 케이스별로 명시 회귀 가드 + 메모리 노트 (timeline-turn-merge-lazy-task / openclaw-tool-payload-mapping / apme-updaterun-colmap-trap).

---
