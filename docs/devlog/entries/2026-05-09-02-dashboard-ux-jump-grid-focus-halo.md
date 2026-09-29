# 2026-05-09 — Dashboard 세션 행 UX: Jump grid 제거 + focus halo

### 문제

macOS Dashboard 좌측 HUD 의 세션 행을 클릭하면 5셀 (메뉴바) / 4셀 (Dashboard)
"Jump to..." 아이콘 그리드 (iTerm / VS Code / Cursor / Finder / Dashboard)
가 펼쳐졌지만 모든 셀이 dead UI: `SessionInfo` 에 `projectPath` 가
hook payload 에서 안 흘러와 모든 셀이 "앱을 빈 상태로 켤 뿐". Dashboard
셀은 메뉴바 헤더의 별도 "Dashboard" pill 버튼과 완전 중복.

그리드를 제거한 뒤 새로운 critique: row tap 이 invisible. `focus_session`
명령은 daemon 의 routing 셀렉터일 뿐이라 (model/effort 라벨, AttentionTheater
question, D200H 버튼 0, option 응답 라우팅) awaiting 세션이 0 일 때
사용자 측 시각 피드백이 0. "row tap 이 의미 있나?" 라는 인상이
재발생.

### 해결

**1단계: Jump grid 통째 제거** (commit `c37e9526`)

- `SessionJumpRow.swift` — `expanded` / `onToggle` / `onJumpDashboard` /
  `onJumpExternal` 4 콜백 → 단일 `onFocus` 로 축소. `JumpTarget` enum,
  `jumpCell()`, `SessionJumpLauncher` 통째 삭제. chevron rotation +
  "JUMP TO" 헤더 + 5 셀 그리드 제거.
- `SessionListPanel.swift` — `expandedSessionId` State + `stableId(suffix:)`
  + `jumpGrid(for:)` 삭제. `sessionRowInteractive` 를 단일
  `Button { focusSession }` 로 평탄화.
- `ControlTowerPanel.swift` — `expandedSessionId` State + 그것을
  정리하던 `.onChange(...)` collapse 블록 삭제. 콜사이트 4 콜백 →
  `onFocus` 단일.

**2단계: Terrarium focus halo** (commit `80095e8b`)

- `TerrariumState.focusedSessionId: String?` 신설.
- `DashboardState.toTerrariumState` 의 cloud-folding 루프에서 focused
  thread id 가 folded 상태이면 representative.id 로 재매핑
  (`resolvedFocusId`). 이래야 Codex 가 fold 된 상황에서도 보이는 cloud
  sprite 에 halo 가 붙음.
- `TerrariumRenderer` 에 `focusedSessionId` / `focusPulse` /
  `focusPresence` 상태 추가. `update(dt:state:)` 에서 hasVisibleFocus
  (octopus / cloud / opencode dict 에 id 존재) 를 검사해 presence target
  0/1, dt * 6.0 lerp 로 페이드. `drawFocusHalo()` 가 Layer 6.7 (Layer 6.5
  back-tetra 이후, Layer 7 crayfish 이전) 에서 cyan disc + neon ring 을
  pulse 와 함께 그림. `presence > 0.01` 가드로 페이드아웃 후 자동 skip.

### 핵심 설계 결정

**Jump grid 의 진짜 부재 원인**: `projectPath` 가 hook payload 에 없음.
정식 "이 세션의 터미널로 점프" 는 hook 측 `TERM_PROGRAM` /
`ITERM_SESSION_ID` / tty / parent_pid 캡처 + Swift 측 `NSAppleScript`
기반 jump (iTerm + Apple Terminal 만 현실적, VSCode/Cursor 통합 터미널은
본질적으로 외부 제어 불가) + `NSAppleEventsUsageDescription` entitlement
가 필요. App Store 빌드 호환 (subprocess 없음, in-memory `NSAppleScript`).
이는 별개 PR 로 분리 — dead UI 를 placeholder 로 유지하지 않음.

**focus halo 는 Layer 6.7**: back-layer fish (Layer 6.5) 위, crayfish
(Layer 7) 아래. 모든 creature (octopus / cloud / opencode) 보다 뒤에
그려져 sprite 가 halo 안에 깔끔히 앉음. Bubbles / front-tetra / water
surface 보다는 뒤라 환경 효과를 가리지 않음.

**presence envelope 가 핵심**: 단순 boolean on/off 면 세션 list 가
재정렬되거나 creature 가 잠깐 사라졌다 돌아올 때 halo 가 깜박임. `dt *
6.0` lerp (~166 ms 시정수) 로 부드럽게 페이드. `hasVisibleFocus` 검사로
focus 가 있어도 sprite 가 없으면 즉시 페이드아웃.

**Codex fold 해소를 mapping 단계에서 처리**: renderer 가 `[String: String]`
alias map 을 따로 들고 다닐 필요 없이, cloud-folding 루프 안에서
`members.contains(focused) → resolvedFocusId = representative.id`. 단일
필드로 끝.

---
