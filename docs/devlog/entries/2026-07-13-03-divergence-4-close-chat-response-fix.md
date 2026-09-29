# 2026-07-13 — 타임라인 구조적 divergence 4종 CLOSE + 데몬 chat_response 앵커 버그 fix

### 배경
직전 세션의 렌더 드리프트 수정 후 남은 **구조적 divergence 4종**을 사용자와 우선순위 협의(4개 모두 선택) + 추가로 "요청↔응답 페어링" 일관성("가끔 답변만 튀어나온다")을 **실데이터로 분석**하라는 지시. 두 `timeline.json`(Node `~/.agentdeck`, Swift 컨테이너)을 백그라운드 에이전트로 감사.

### ★데이터 감사 핵심 발견 — "답변만 튀어나옴"은 클라 렌더버그가 아니라 **데몬 emit-path 버그**
- Swift store `chat_response`의 **42%(22/53)가 `startedAt=null`**로 방출 → 앵커 없음. 앵커가 있는 31개는 **31/31 완벽 페어링**. 순서이상 0, 중복 0.
- null 앵커 22개 중 **13개는 같은 세션에 유효한 `chat_start`가 실재**(claude-code 15/codex-cli 7). 즉 페어는 존재하나 데몬이 응답에 앵커를 안 찍음.
- 근본원인: `ChatTurnAnchorTracker.claimOpenTurn`이 anchor를 **소비(remove)** → 중복/지연 Stop 훅이 nil 반환 → `respEntry.startedAt = nil`. fallback 없음.
- Node store는 다른 문제(범위 밖): `tool_exec` 77개가 100-cap 채워 `chat_start` 축출(버퍼 aging) + 응답 중복.

### 데몬 앵커 fix (DaemonServer.swift)
`ChatTurnAnchorTracker`에 **소비되지 않는 `lastChatStartTs`** 추가(noteChatStart가 세팅, claim이 안 지움, clear가 지움). 3개 emit 함수(`appendClaudeCodeChatEnd`/`appendCodexChatEnd`/`appendOpenCodeChatEnd`)에서 `let startTs = claimedTs ?? lastChatStart(sid)`. **guard/open-turn 결정은 `claimedTs` 유지** — 응답 없는 지연 Stop이 유령 "Completed" 행을 새로 만들지 않게. 응답이 항상 자기 턴 chat_start에 앵커됨.

### 클라이언트 수렴 픽스 4종
- **① history 수신**: Swift 클라 `mergeHistory`(ts-only dedup+append, no clear)→`replaceSnapshot`(ts-type-raw dedup + **replace-on-connect**, Android 파리티). 외부 Node 데몬 재연결 시 재스탬프 OpenClaw 고스트행 누적 제거. AgentStateHolder `.timelineHistory` 핸들러도 교체.
- **② 그루핑 술어**: Swift `sameSession`(sessionId만)→`sameTimelineContext`(taskId→runId→sessionId→project+agent 4단계, Android 미러). Swift 내부 display-filter(풀컨텍스트)와 일치, 병렬세션 runId 분리 그루핑. 2 호출처(×count collapse, turn merge) 교체.
- **③ Android 부재 UI 이식**: `TimelineSessionFilter`+`TimelineEntry.matchesTimelineFilter`(TimelineDisplay.kt, Swift 미러) / MonitorScreen `focusedSessionId` 기반 필터 빌더(primary→sibling→openclaw-gateway→bare) / TimelineStrip `filter` 파라미터+필터링+헤더 `· label`(TetraNeon)+빈상태 "No events for this session"+선택 리셋 / `summaryBackendLabel`(AI/MLX/Ollama/Heur) pill 2곳(standalone chat_end + merged completion 서브라인).
- **④ 버퍼캡+스토리지필터**: Swift 클라 cap 200→**500**(Android 파리티). 클라 `normalizeTimelineEntryForStorage`(Model/Timeline.swift) 추가 — 기존 display `timelineIsLowSignalEntry` 재사용 + `timelineIsOpenClawLowSignalResponse` 드롭 + cron 요약; addEntry(upsert 포함)/replaceSnapshot 양 경로 배선. OTel/tool 노이즈가 버퍼 슬롯 점유 못 하게(iOS + macOS-외부데몬 모드).

### 검증
- macOS `xcodebuild` **BUILD SUCCEEDED**. Swift 테스트 **114/114 통과**(신규: 앵커 fallback×4, replaceSnapshot authoritative/저신호 드롭, cap 500, runId 그루핑×2).
- Android `compileDebugKotlin` clean + `TimelineStoreTest`(신규 `matchesTimelineFilter`×5) **BUILD SUCCESSFUL**.
- iOS: 변경 파일 전부 컴파일 통과(빌드 실패는 **기존 `SettingsScreen.swift` `link` unavailable-in-iOS**, 이번 작업과 무관).

### 미해결(범위 밖, 보고)
(a) Swift 클라 `addEntry(upsert)` 전체교체 vs Android `upsertEntry` 필드머지 — task-judge rollup 필드 보존 갭 가능. (b) Node store `tool_exec` 100-cap 버퍼aging + 응답중복 = Node 데몬 자체 이슈. 상세 [[timeline-client-divergence-two-store-topology]].
