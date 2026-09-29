# 2026-07-05 — 라운드 17: 타임라인 귀속 파이프라인 정합 + 멀티 데몬 핸드오프 견고화 + fresh-daemon stale 정리

### 배경
대시보드 타임라인 아이콘이 전 표면에서 깨지고, `daemon restart`/`stop`/역방향(app→CLI) 핸드오프에서 macOS 재접속 실패·InkDeck "no active sessions"·미지원 usage 흔적 잔존·Android stale 로그가 발생. 사용자가 여러 데몬 핸드오프 시나리오를 probe하며 다수의 갭을 노출.

### 해결
- **타임라인 귀속(아이콘)**: 근본원인=타임라인 행 71%가 `agentType: undefined`. `bridge-core` wireTimeline attributor(저장시점 단일 chokepoint)에서 collector `getRunAgentType()`로 backfill. 신규 `shared/src/timeline-label.ts` SSOT(agentDisplayLabel/timelineRowAttribution/formatTimelineRowLabel) + 언어 미러(Kotlin `BrandIcon.agentDisplayLabel`, C++ `esp32/src/ui/agent_label.h`).
- **ESP32**: device `TimelineEntry`에 agentType/projectName/taskId 파싱 추가(파서가 버리고 있었음); InkDeck 티커·IPS10 카드가 "agent·project·task·text" 조합.
- **Android**: 태블릿 agent+project 라벨, e-ink 타임라인=스크롤 폐기·최신1건 뷰.
- **Swift stale spinner**: 완료가 timestamp-인접 merge에만 의존→lenient `timelineHasLaterCompletion` + chat_start age-cap.
- **멀티 데몬**: Node eink-device 등록 포팅(Swift 전용이었음); serial sessions_list 하트비트 재sync(양 데몬); `daemon restart` promotion 가드(포트 점유중 승격 스킵); 역방향 takeover(`isSwift` 감지→Swift `POST /stand-down`+`standDownForTakeover`+yieldUntil, /shutdown fallback).
- **fresh-daemon stale**: macOS 승격 엣지 `clearRelayedUsageState`; Android Disconnected서 usage/LIMITS clear·Connected서 timeline clear; Node 데몬 빈 `timeline_history`도 항상 전송.
- **chat_response taskId**: Swift 데몬이 attributor 우회 수동 방출로 taskId 누락→Q&A 분할. Claude·Codex 응답 경로에 `activeTaskId` 태깅(Node는 attributor로 이미 OK).

### 핵심 설계 결정
- 귀속은 **저장시점 단일 attributor**에서, 표시명은 **shared SSOT + 언어 미러**로 — 표면별 하드코딩 제거.
- 데몬 전환 stale 정리는 **전환 엣지**(승격/Disconnected)에서 clear, transient blip엔 유지(flicker 방지). Codex/AGY는 로컬 재방출이라 clear 안전.
- takeover는 앱을 죽이지 않는 clean demote(`/stand-down`) + self-heal(실패시 yieldUntil 만료 후 재승격).
- 검증: vitest 1629/1629, ESP32 inkdeck+ips10 SUCCESS, macOS BUILD SUCCEEDED, Android compileDebugKotlin SUCCESSFUL.
