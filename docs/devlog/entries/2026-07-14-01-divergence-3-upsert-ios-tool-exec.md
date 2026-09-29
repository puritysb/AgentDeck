# 2026-07-14 — 타임라인 divergence 후속 3종: 클라 upsert 필드머지 + iOS 빌드 복구 + tool_exec 축출 파리티

### 배경
직전 세션(`228709f3`)이 divergence 4종 CLOSE + 데몬 앵커 버그를 고치며 남긴 **미해결 후속 3종**을 우선순위대로 처리. 항목 (a)/(b)는 [[timeline-client-divergence-two-store-topology]]의 "미해결" 목록, 항목 (2)는 기존 iOS-target break.

### ① Swift 클라 `TimelineStore.addEntry(upsert:)` 전체교체 → 필드머지
증상: 클라 upsert 두 경로(task_end-by-taskId, ts+type) 모두 `entries[idx] = entry` **전체교체**. task-judge rollup(taskScore/Outcome/Category/Summary)은 boundary 후 5–30s의 **2차 task_end emit**에 실려 오는데, 그 뒤 nil-rollup 재emit(중복/진행)이 오면 이미 세팅된 score를 덮음. Node `BridgeTimelineStore` merge-path·Android `upsertEntry`는 이미 `incoming ?? base` coalesce인데 Swift 클라만 미적용. Fix=`mergedUpsert(base:incoming:)` 헬퍼(모든 optional coalesce, raw는 최신, ts/type 정체성은 base 유지). 회귀 테스트 `testTimelineStoreUpsertMergesTaskRollupWithoutClobbering`(boundarySignal/startedAt 보존 + nil 재emit이 score 안 덮음).

### ② iOS 타깃 빌드 복구 — macOS 전용 API 2곳 가드
- `SettingsScreen.swift`의 APME judge 프리셋 버튼 3개가 `.buttonStyle(.link)`(macOS 전용)을 크로스플랫폼 뷰에서 참조 → iOS 앱 빌드 break. Fix=`presetLinkButtonStyle()` 헬퍼(macOS `.link` / iOS `.borderless`). iOS 앱 **BUILD SUCCEEDED**.
- 그 break를 고치자 **가려져 있던 2차 break** 노출: `DevicePreviewSnapshotTests.swift`의 `NSBitmapImageRep`(AppKit)이 iOS 테스트 타깃에서 미가드. 이 파일엔 크로스플랫폼 레이아웃 테스트(D200H buildSessionDeck 등)도 있어 클래스 전체 가드는 손실 → PNG 인코딩만 `#if os(macOS)` NSBitmapImageRep / `#else` `UIImage.pngData()` 로 분기(+`#if canImport(UIKit) import UIKit`). iOS **TEST BUILD SUCCEEDED**.

### ③ Node timeline store `tool_exec` 버퍼aging — 검토 → 프리미스 검증 + Node/Swift 파리티 fix
- **검토 결과 프리미스 정확**: `index.ts:1552`가 PTY `agentdeck claude` 세션의 tool action마다 `type:'tool_exec', agentType:'claude-code'` emit(훅이 2s 내 미발화 시). 저장필터 `shouldDropLowSignalTimelineEntry`는 **codex tool_exec만 드롭**(claude/opencode는 통과). 200-cap의 `evictOne`이 chat_start를 tool_exec와 동급 FIFO로 취급 → chat_start(턴 최古 ts)가 자기 tool_exec보다 먼저 축출 → reconnect 시 `timeline_history`에 응답만 남는 고아행(Node측 "답변만 튀어나옴").
- **★진단 주의**: 라이브 `~/.agentdeck/timeline.json`의 codex tool_exec 87개는 **필터 이전 옛 Node 데몬 stale 산출물**(현 9120=Swift 앱). 현재 실행 Swift store(200행)는 **tool_exec 0개** — codex는 이미 드롭됨. 즉 codex는 무해, 잔여 위험은 claude/opencode PTY tool_exec.
- Fix(**두 데몬 파리티**): Node `BridgeTimelineStore.evictOne` + Swift `DaemonTimelineStore.evictOne` 둘 다 generic non-task 축출 전에 **oldest `tool_exec` 우선 축출**(tool_exec은 request/resolved 페어 없는 독립행이라 안전, turn skeleton 보존). 테스트: Node `timeline-task-retention`(tool-heavy 턴에서 chat_start 생존) + Swift `testDaemonTimelineStoreShedsToolExecBeforeChatStart`.

### 검증
- Node **vitest 100파일 1770 통과**(신규 축출 테스트 포함). Swift **macOS 400 통과**(1 skip). **iOS 앱+테스트 타깃 BUILD SUCCEEDED**.
- 상세 [[timeline-client-divergence-two-store-topology]].
