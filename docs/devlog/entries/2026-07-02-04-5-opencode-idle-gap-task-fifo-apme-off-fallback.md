# 2026-07-02 — 타임라인 완결성 후속: 갭 5건 구현 (마일스톤 행 · OpenCode idle-gap · task 행 FIFO 보호 · APME-off fallback · unscored 종결)

### 배경
dd43efd2(중복/이중 인제스트 수정)에서 확정만 해 둔 잔여 갭 5건. 사용자 방향 확인 후 전부 구현 (①마일스톤 행 표면화 ③task 행 FIFO 보호 ⑤타임아웃→unscored 는 권장안 채택).

### 구현
1. **`task_milestone` 타임라인 타입 신설** — TodoWrite-all-completed soft hint(발화율 ~18%, 비세그먼트 유지)를 타임라인 행으로 표면화. `shared/src/timeline.ts` union + `timeline-icons.ts`(success 아이콘, detail body 제외). Node: `collector.onTaskMilestone` 콜백(per task+turn 1회 dedup, `fireTaskMilestone`) → `apme/index.ts` emit(`Todos done (N)`). Swift 패리티: `ApmeCollector.emitTaskMilestoneIfNeeded`(deferred task_start 승격 포함) + `Timeline.swift` enum case + TimelineStripView `TODOS ✓` 라벨/아이콘. Kotlin: TimelineIcons.kt 매핑. `pnpm generate-protocol` 재생성. 소비 표면 전수조사 결과 미인지 클라이언트는 전방 호환(Swift lenient enum `.unknown`, Kotlin String type).
2. **OpenCode idle-gap 경계** — OpenClaw 미러: `opencode-hook.ts`에 `OPENCODE_IDLE_GAP_MS=90s` + `opencodeIdleGapTaskBoundary()`; 어댑터가 `session.idle`에서 arm, 새 작업 신호(`beginChatIfNeeded`)·shutdown에서 clear, 발화 시 `task_boundary(idle_gap)` span → `closeTask`. 이전엔 session_end로만 닫혀 세션=1태스크(per-task eval 무효).
3. **task 행 FIFO 보호** — `BridgeTimelineStore`: 일반 FIFO에서 task 행 제외, 별도 캡 `MAX_TASK_ENTRIES=60`(초과 시 닫힌 태스크부터 evict, in-flight `task_start`는 절대 evict 금지), `loadPersistedEntries` trim·`getHistoryForSession`(limit=chat/tool에만 적용, task 행은 전량 동승) 동일 보호. Swift `DaemonTimelineStore` 미러(evictOne/loadFromDisk/historyForSession).
4. **APME-off fallback task 행** — 신규 `bridge/src/fallback-task-timeline.ts`: better-sqlite3 로드 실패 시 hook 경계 신호만으로 task_start/task_end 행 발행(합성 taskId, eval 없음). daemon-server hook 엔드포인트(`json.session_id` per-session 귀속) + 세션 브리지 index.ts hook 경로에 wiring.
5. **eval 배지 unscored 종결** — `TaskEvalBadge`에 `closedAt` 추가: task_end 후 5분 내 judge 결과 없으면 "…"→"unscored" 확정 표기 (judge 비활성/백엔드 다운/enqueue 유실 시 영구 pending 방지).

### 검증
vitest 92파일/1635 pass(신규: timeline-task-retention 4, fallback-task-timeline 3, apme-task-milestone 2), `xcodebuild AgentDeck_macOS` BUILD SUCCEEDED, Android `compileDebugKotlin` OK.

---
