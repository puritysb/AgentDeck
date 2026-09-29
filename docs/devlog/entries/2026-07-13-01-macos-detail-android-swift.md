# 2026-07-13 — 타임라인 클라이언트 렌더 패리티: macOS detail 중복/선택 + Android↔Swift 드리프트

### 배경
사용자 지적 2건: ① Android 태블릿 TIMELINE이 macOS와 조금 다르게 보임, ② macOS detail 영역에 중복 텍스트 + 일부 영역만 드래그 선택됨. 토폴로지(두 데몬/두 스토어)가 아니라 전부 **클라이언트 렌더 드리프트**로 확인(9120=Swift 데몬, 양 클라이언트 동일 스트림 수신). 병렬 Explore 에이전트 2기로 macOS detail 감사 + Android↔Swift 파이프라인 divergence 매핑.

### macOS detail 영역 (2건)
- **중복 텍스트**: standalone `chat_response`는 모든 producer가 `raw`=`detail`의 문자 접두어 절단(200/1000자)으로 스탬프하는데 detail pane이 볼드 Summary(raw)+markdown 본문(detail)을 둘 다 무조건 렌더 → 응답 서두가 두 번(위=마크다운 원문, 아래=포맷). 본문 표시 시 Summary가 본문 서두면 억제(`timelineSummaryIsRedundantWithDetail`, 마크다운 스트립 토큰-접두어 비교로 절단 경계 mid-word 허용). 병합 턴(프롬프트+응답)은 프롬프트가 응답의 접두어가 아니라 유지.
- **부분 드래그 선택**: `.textSelection(.enabled)`이 markdown 본문에만 있어 Summary·타임스탬프·lifecycle 행이 선택 불가였고 본문도 라인마다 별도 Text라 조각남. pane-wide selection + 연속 text/code 라인을 단일 Text로 coalesce.

### Android 태블릿 ↔ macOS Swift 패리티
가장 큰 원인: Android DetailPane이 `timelineDetailIsRedundant` 게이트를 응답에도 적용해 **응답 본문을 거의 항상 숨김**(summary=detail 접두어라 8-토큰 규칙 무조건 발화)+`bodyEntry.summary`가 병합 턴에서 **프롬프트 소실**. Apple의 `shouldShowDetailForDashboard` 게이트+`timelinePromoteInformativeLead`+summary redundancy를 Kotlin으로 포팅. 추가: 아이콘 색을 수동 `typeColor` 맵 대신 아이콘 키에서 유도(chat_end/tool_request/eval_result/chat_response 4종 불일치 해소), TaskEvalBadge "…"→"unscored" 5분 전이, `task_milestone` 라벨("TODOS ✓").

### 스피너 정확성 (shared/Apple/Android SSOT 3미러)
- in-flight task 스피너에 10분 staleness 캡을 shared+Android에 추가(기존 Apple 전용) → 태블릿 고아 task 행 영구회전 해소.
- Swift `timelineIsRotatingEntry` chat_start에 shared sibling 스캔 포팅(후속 동일세션 completion 또는 superseding chat_start면 즉시 정지 — 기존엔 10분 age 캡만).

### 미수정 (구조적, 보고만)
history 수신 replace+clear-on-connect(Android) vs ts-only merge(Swift) → 외부 데몬 모드에서 macOS 고스트행 가능; 그루핑 술어 Swift `sameSession` vs Android 풀컨텍스트; ×count 동등성; eval_result 윈도; per-session 필터·summary 백엔드 pill의 Android 부재; 버퍼캡 500vs200. 상세는 [[timeline-client-divergence-two-store-topology]] 메모리.

### 검증
- shared vitest 47, Swift 96(+6), Android 218(+7); `pnpm build` green; design lint 905(불변).
- **실기**: macOS 재시작 후 REPLY 행 무중복+선택 동작, 태블릿 재배포 후 병합/standalone detail·unscored 배지 확인. 커밋 4899695a (origin/master).
