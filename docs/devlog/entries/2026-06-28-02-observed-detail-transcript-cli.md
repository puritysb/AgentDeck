# 2026-06-28 — observed 세션 Detail = transcript 재구성 (CLI 데몬)

### 문제
XTeink X3 가 세션 Detail 을 열면 `query_session_timeline` 으로 히스토리를 요청하는데, **passively-observed 세션**(ps 로 발견되는 claude/codex 세션)은 항상 빈 응답("No recent activity yet")만 받았다. relay 경로(`SessionTimelineRelay`)는 managed + hook 세션만 timeline store 에 push 하고, observed 세션은 timeline 행이 하나도 없기 때문.

### 해결
신규 self-contained 모듈 `bridge/src/session-transcript-timeline.ts` + `query_session_timeline` 핸들러 fallback. store 가 비면 세션의 Claude Code transcript JSONL(`~/.claude/projects/*/<uuid>.jsonl`)을 replay 해 최근 활동을 `TimelineEntry[]`로 재구성:
- user 프롬프트 → `chat_start`, assistant 텍스트 → `chat_response`, tool_use → glanceable `tool_request`("Editing config.ts", "Reading foo.cpp", "Running npm test"…)
- 각 entry 에 조회한 sessionId(observed: prefix 포함)를 다시 찍어 기기 Detail 필터(`rawSid()` 양쪽 비교)와 매칭.
- transcript 위치는 cwd 없이 session id 만으로 `projects/*/<uuid>.jsonl` 스캔(=`findClaudeTranscript` fallback 미러). read-only, 절대 throw 안 함.

### 핵심 설계 결정
- **CLI 데몬 전용**: App Store Swift 데몬은 샌드박스가 `~/.claude/settings.json` 만 grant 하고 per-session transcript jsonl 접근 권한이 없다 → observed 세션 transcript-level Detail 은 외부 Node 데몬(`isUsingExternalDaemon`) 기능. 기존 progressive-enhancement 아키텍처와 일치.
- **firmware 무변경**: Detail 진입 시 이미 `sendQuerySessionTimeline()` 호출 + `handleTimelineHistory()` 가 ring 적재. 빈 응답이 아닌 entry 를 받기만 하면 됨.
- **동시세션 격리**: `daemon-server.ts` 에 다른 세션의 미커밋 작업(FoundationModels `/generate`, hookCwd, cockpit)이 있어 isolated-commit 으로 내 두 hunk 만 격리 커밋(`f8ae8720`), 나머지는 working tree 에 복원.

### 문제
모니터링 대상에 Antigravity가 추가됐지만 (1) 네이티브 테라리움(Swift/Android/ESP32)에 크리처가 없어 octopus/dot로 폴백됐고, (2) 남은 사용량 표시는 Claude 5h/7d만 있었다. Codex 사용 리밋과 Antigravity 사용량도 보여달라 — 단 Antigravity는 ToS 주의.

### 해결
- **Antigravity 크리처**: peak/arc 크리처를 Swift 테라리움 + Android + ESP32 글리프(4표면)에 추가, octopus 필터에서 제외.
- **Codex 사용 리밋**: Codex CLI가 자기 로컬 rollout(`~/.codex/sessions/.../rollout-*.jsonl`)의 `token_count.rate_limits`에 5h(primary)/7d(secondary) used_percent+resets를 쓴다 → `bridge/src/codex-rate-limits.ts`(+Swift `UsageAPIClient.readCodexRateLimits`)로 읽어 `usage_update`에 실어 macOS/iOS/메뉴바/Android 대시보드 + Stream Deck + D200H에 표시. **API 호출 없음, 로컬 파일만.**
- **App Store 샌드박스**: 사용자가 `~/.codex` 폴더를 한 번 허용(보안 스코프 북마크, Antigravity DB 피커와 동일 패턴)하면 샌드박스 데몬도 읽음 — subprocess/홈-상대 엔타이틀먼트 없음.
- **게이지 재설계(Stream Deck/D200H)**: 풀블리드 레벨 채움(사용률만큼 차오름, 초록→호박→빨강 단계색 0.38 톤 + 3px 수위선), 전부 흰 글자 + 테두리 없음(작은 글씨 가독성), 점 대신 제공사 브랜드 로고. SD+ 인코더는 다이얼로 뷰 순환(both→5h→7d→session), PROMPT 인코더 폐기→선택지 키패드 이동. D200H는 게이지를 넓적버튼 위 2×2 블록(3_0/4_0 Claude, 3_1/4_1 Codex)에 배치.
- **키패드/D200H 정리**: 눌리지만 무동작이던 INFO/상태카드/TOKENS/COST → 납작 라벨로 재스타일.

### 핵심 설계 결정
- **Antigravity 두-그룹(Gemini / Claude+GPT-OSS) 5h·weekly % 쿼터는 백엔드 전용** — `state.vscdb`/CLI 어디에도 로컬 영속되지 않음(aggregate credit+plan명만 로컬). 이를 보여주려면 Google 비공개 엔드포인트 호출 필요 = ToS 위험이라 **표시 안 함, plan명만**. (memory: antigravity-quota-two-pool-backend-only)
- 데이터 생산(데몬)과 렌더(플러그인/앱)가 분리 — 반영하려면 데몬 재시작 + 각 소비자 리로드/재빌드 둘 다 필요. show/hide 불변식·Swift/CLI 데몬 패리티 유지.
