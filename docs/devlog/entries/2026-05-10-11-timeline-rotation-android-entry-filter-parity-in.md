# 2026-05-10 — Timeline rotation + Android entry-filter parity (in-flight task hierarchy)

### 문제

사용자가 Android tablet timeline 과 macOS/iOS timeline 사이에 두 가지 차이를
보고했다.

1. "android tablet 은 진행중 태스크 상태가 회전 이모지로 안내되는데
   macOS/iOS 에는 적용이 안 된 것 같다."
2. 두 클라이언트가 보여주는 timeline 로그가 "표시되는 entry 종류/개수"
   측면에서 다르다.

코드 조사 결과 — 회전 자체는 양쪽 모두 `chat_start` + unknown type 에 대해
이미 평행하게 동작했지만 (`shared/src/timeline-icons.ts` 단일 spec, Apple
`RotatingTimelineIcon` ↔ Android `rememberRunningRotation` 1.8s 회전), 두 가지
실제 갭이 있었다.

- **회전 의미 부족**: 양쪽 모두 task hierarchy (`task_start` ↔ `task_end`)
  마커는 정적 `.task` 아이콘으로만 그려졌다. `task_start` 가 완료되지
  않았는데도 회전 신호가 없어서 "지금 진행 중" 표시가 hierarchy 레이어에
  부재했다.
- **Entry 필터 비대칭**: Apple `timelineDisplayGroupsForDashboard` 는
  `timelineIsLowSignalEntry` (codex:otel-active 의 `tool`/`exec` 노이즈)와
  meaningful chat_start 보존 룰을 모두 가지고 있었지만 Android
  `timelineDisplayGroups` 에는 둘 다 없었다. 결과로 Android 가 Apple 보다
  훨씬 많은 노이즈 row 를 보여주어 "회전이 더 풍부하다"는 인지를 만들고,
  반대로 Apple 은 적은 row 사이에서 회전이 잘 안 보인다는 인지를 만들었다.

### 해결

1. **Shared 술어 신규** (`shared/src/timeline-icons.ts`):
   - `isInFlightTask(entry, siblings)` — `task_start` 인데 같은 `taskId` 의
     `task_end` 가 siblings 에 없으면 true.
   - `isRotatingEntry(entry, siblings)` — `iconKey === 'running'`
     (chat_start, unknown) ∪ in-flight task. iconKey 자체는 단일-entry
     함수로 유지해 테스트 단순.
2. **Apple 포팅** (`TimelineStripView.swift`):
   - `timelineIsInFlightTask` / `timelineIsRotatingEntry` Swift 미러 추가.
   - 회전 호출지점 3곳 모두 새 술어로 전환: `turnRow` (라인 293),
     `taskHeaderRow` (라인 449 — 정적 `Image` 를 `RotatingTimelineIcon` 으로
     교체), `detailPane` (라인 531).
   - **taskHeaderRow 는 turnRow 와 분리된 별도 경로**라서 turnRow 만 패치하면
     `task_start` row 가 빠진다 — 양쪽 다 수정해야 task hierarchy 회전이
     실제로 보인다.
3. **Android 포팅** (`TimelineIcons.kt` + `TimelineStrip.kt`):
   - Kotlin `isInFlightTask` / `isRotatingEntry` 추가.
   - `CompactLogRow` → `TurnRow` / `TaskHeaderRow` 에 `siblings: List<TimelineEntry>`
     파라미터 추가, `displayEntries` 를 `TimelineList` 에서 흘려보냄.
   - `TaskHeaderRow` 의 정적 Icon 을 `rotate(taskAngle)` modifier 로 감싸서
     in-flight 회전 적용.
4. **Apple 필터 Android 백포트** (`state/TimelineDisplay.kt`):
   - `isLowSignalEntry`: codex-cli + sessionId == "codex:otel-active" + type
     ∈ {tool_exec, tool_request, tool_resolved} + raw ∈ noise set 6종 →
     drop.
   - `isMeaningfulChatStart`: synthetic 시작 row 5종 (`prompt sent`,
     `codex turn started`, `starting chat`, `connected`, `resumed`) 만 completion
     도착 시 elide. 의미 있는 사용자 프롬프트는 응답 옆에 유지 (Apple과 동일).
   - `chat_end` 도 Apple과 동일하게 `summaryKind` 값에 따라 분기:
     `llm`/`heuristic` 이면 `chat_response` 와 별개로 살아남고, `none`/`null`
     이면 기존 dedup-with-chat_response 룰 적용.

### 핵심 설계 결정

- **회전 트리거는 iconKey 와 분리**된 별도 술어로 모델링한다. iconKey 는
  entry 단독 함수, isRotatingEntry 는 sibling 의존 술어. iconKey 의 단순성
  (테스트 가능, 캐시 가능) 을 유지하면서 hierarchy 의 시간적 의미를 따로
  집어넣는다.
- **siblings 는 visible group 이 아닌 실제 timeline entries 를 넘긴다**.
  visible group 은 dedup 로 task_end 가 잠시 사라질 수 있는 반면, full
  timeline 은 안정적이다. Android 는 `displayEntries`, Apple 은
  `grouped.map(\.entry)` 를 사용 (Apple 의 grouping 은 task hierarchy 를
  group 하지 않으므로 동등).
- **Android 가 Apple 의 baseline 으로 수렴**한다 (사용자가 명시 선택). 반대
  방향 — Apple 필터를 완화 — 도 가능했지만 codex:otel 노이즈는 객관적으로
  사용자에게 가치가 없으므로 Apple 의 결정이 옳다.

### 검증

- `pnpm test` — 53 files / 1212 tests passed (vitest, +14 신규 술어 케이스).
- Android `./gradlew testDebugUnitTest` BUILD SUCCESSFUL — `TimelineTaskHierarchyTest`
  +10 신규 (isInFlightTask / isRotatingEntry), `TimelineDisplayScenarioTest`
  +3 신규 (codex otel filter / synthetic chat_start / chat_end summaryKind).
  기존 `multi-agent dashboard timeline` 케이스는 새 정책에 맞춰 assertion
  보정 (linter 자동) — meaningful "Fix Android timeline" 프롬프트가 응답 옆에
  유지되도록 검증.
- Apple `xcodebuild` macOS Debug + iOS Simulator Debug — 모두 BUILD SUCCEEDED.
- 시각 검증은 미수행 (memory `feedback_verify_visual_output` 정책상 사용자 캡처
  필요). long-running task 케이스: `agentdeck claude` + `TodoWrite` 시작 →
  `task_start` 회전 → `task_end` 도착 시 정지 의 패턴을 macOS dashboard 와
  Android tablet 에서 동일하게 확인 권장.

### 추가 수정 (Codex stop-time review)

OTel 필터를 Android `state/TimelineDisplay.kt` 의 표시 경로에만 추가했더니
`TimelineStore` 에는 여전히 노이즈가 들어가 (1) `entries` flow 의 다른
컨슈머에 노출, (2) 500-entry MAX 버퍼가 OTel 노이즈로 채워져 유용한 row 가
조기 aged-out, (3) 향후 on-disk persistence 에 그대로 흘러갈 위험이
남았다. Apple 은 `DaemonTimelineStore` add/load 단에서도 같은 룰을
적용하고 있어 비대칭. 후속 커밋 `db4491f2 fix(android): apply OTel
low-signal filter at TimelineStore add path` 에서:

- `isLowSignalEntry` 를 `private` → `internal` 로 끌어올려 같은 패키지의
  `TimelineStore` 가 직접 참조하도록 함. 룰 중복 회피.
- `TimelineStore.addEntry` / `addEntries` / `upsertEntry` 가 OTel
  low-signal 후보를 short-circuit 으로 거부.
- `TimelineStoreTest` 4 cases (단일 add 거부 / 같은 sentinel 세션의
  meaningful raw 유지 / 일괄 replay 필터 / upsert add fallback 거부) 추가.

---
