# 2026-07-02 — TRMNL/D200H blank-frame 근본 원인: PTY 제어문자 → SVG 파스 실패 → 무음 백지 프레임

### 문제
"이미지 스트리밍 기기(특히 TRMNL)에 화면이 안정적으로 표시되지 않는다"는 리포트. 라이브 조사에서 전송로(패널 폴링·RSSI·데몬 헬스)는 정상이었지만, 렌더 파이프라인에서 재현 가능한 근본 원인을 확정: **세션 goal/activity/currentTask 문자열에 ANSI escape(`\x1b[31m` 등)나 제어문자가 섞이면 resvg가 SVG 전체를 거부하고, `renderTrmnlFrame`의 catch가 `debug()` 한 줄만 남기고 순백 blank PNG를 패널에 서빙**한다. `escXml`(5곳 중복 정의)은 `&<>"`만 이스케이프하고 XML 1.0이 금지하는 제어문자는 통과시켰고, `cleanGoal`의 `\s+` 정규식도 `\x1b`를 못 거른다. 툴 인자(예: Bash 명령의 escape 문자)·PTY 파생 텍스트에서 흔히 유입되므로 "특정 세션이 떠 있는 동안만 간헐적으로 백지"라는 증상과 정확히 일치. 재현: goal=`'Fix \x1b[31mred\x1b[0m bug'` → 249바이트 blank 프레임.

### 해결
- **`shared/src/svg-renderers/text-utils.ts`에 `stripUnsafeText`/`escSvgText` 신설** — ANSI(CSI/OSC/2-char) 제거 → XML-불법 제어문자(C0−`\t\n\r`, DEL, U+FFFE/FFFF) 제거 → lone surrogate 제거 → 엔티티 이스케이프. 5곳의 로컬 `escXml`(trmnl-layout, d200h-layout, session-slot-renderer, plugin display-tile)을 이것으로 일원화(qr-renderer의 것은 dead code라 삭제).
- **blank 프레임 방어(defense-in-depth)**: `renderTrmnlFrame` 실패 시 `TrmnlFrame.degraded` 마킹 + `logTagged` 상시 로그(에러 메시지별 1분 rate-limit). frame-cache는 degraded 프레임이 오면 **마지막 정상 프레임을 유지**(stale 대시보드 > 백지 화면), 정상 프레임이 없던 해상도만 blank 허용.
- **캡처 지점 방어**: `cleanGoal`(passive-observer)·`quickActivity`(session-activity)에 `stripUnsafeText` 적용 — Swift/Android 등 SVG 아닌 표면에도 깨끗한 문자열 전파. Swift 허브도 `TrmnlModule.sanitizeText`(NSRegularExpression ANSI + 스칼라 필터)로 sessions_list 인제스트 시 동일 처리.
- **관측성(전송로 dead-window 대조용)**: ① 패널이 폴 윈도우를 놓치고 돌아올 때 1줄 gap 로그(`notePollGap`, 2×cadence+30s 초과, Node+Swift 양쪽) ② firmware가 에러 후 보내는 `POST /api/log`를 debug 게이트 없이 상시 기록(패널당 10s rate-limit, `logs_array` 요약) ③ `logger.ts`·daemon-server 로컬 log()에 ISO 타임스탬프 — 지금까지 daemon-stderr.log의 재시작/사건 시각을 특정할 수 없었다.

### 검증
- 적대 입력 4종(ANSI/제어문자/lone surrogate/emoji+한글) → 전부 정상 프레임(1.8KB+, degraded=false); 수정 전 동일 입력은 249B blank.
- vitest: 신규 `text-sanitize.test.ts`(shared) + `trmnl-frame-cache-degraded.test.ts` + trmnl-renderer 적대 입력 3케이스 포함 관련 스위트 51/51 pass. 전체 스위트의 APME 83개 실패는 stash 검증으로 pre-existing better-sqlite3 ABI 문제(본 변경 무관) 확인.
- `xcodebuild AgentDeck_macOS` BUILD SUCCEEDED (xcodegen 스킴 drift는 원복).
- 라이브: 데몬 재시작 후 실제 패널(1C:DB:D4…)이 재폴링·정상 대시보드 프레임 수신 확인(스크린샷 검증), 15분 텔레메트리 샘플링에서 폴 간격 ~190s 규칙성 확인.

---
