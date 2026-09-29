# 2026-04-19 — Attention popup 동적 옵션 렌더 + e-ink 게이트

### 문제
Dashboard 의 "Attention" popup 이 Claude Code CLI 의 실제 permission prompt 를 왜곡해서 보여주고 있었다. tool-use 승인은 Yes/No/Always 3개지만, plan approval 은 5+ 옵션, `/openclaw` OAuth 는 Scope → Token → Submit 같이 단계별 sequential prompt, AskUserQuestion 은 임의 numbered list — 모두 각각 라벨/개수가 다른데 Apple `AttentionTheaterHUD`/`AttentionTheaterView` 와 Android `AttentionTheaterHUD` 가 Yes/No/Always 를 3개 버튼으로 하드코딩하고 `state.options` 배열을 통째로 무시하고 있었다. 결과적으로 5-옵션 plan 승인이나 OpenClaw Scope 단계도 "yes/no/always" 3개 버튼으로 나왔다. 부수적으로 Android e-ink 기기(CremaS/Onyx/Kobo/Pantone)도 이 interactive popup 을 띄우고 있었는데 e-ink 리프레시 특성상 버튼 UI 는 부적합했다.

### 해결
- **파서/프로토콜은 이미 완비돼 있었다.** `bridge/src/output-parser.ts:437-528` 이 `permission_prompt`/`option_prompt`/`diff_prompt` 를 emit 할 때 이미 `options: PromptOption[]` + `navigable` + `cursorIndex` 를 실어 보내고, `bridge/src/bridge-core.ts:217-242` 가 상태별로 `promptType`(yes_no / yes_no_always / multi_select / diff_review) 을 계산해 `state_update` 에 박아준다. Apple `DashboardState.options/promptType/navigable/cursorIndex` 와 Android `DashboardState.options/promptType/navigable/cursorIndex` 도 이미 populate 되어 있었다. **UI 만 그 데이터를 무시하고 있었다.**
- **Apple 동적 렌더**: `AttentionTheaterHUD.swift` + `AttentionTheaterView.swift` 를 `ForEach(state.options)` 루프로 재작성. ≤3 짧은 라벨(≤14자) 은 수평 3버튼(classic green/red/cyan 팔레트 유지), 그 외(>3 옵션 또는 긴 라벨 또는 `promptType == .multiSelect`) 는 수직 스크롤 리스트(neutral 팔레트 + recommended 녹색 + deny-like 빨강). `cursorIndex` 외곽선, `selected` ✓, `recommended` 굵은체. 빈 배열은 yes/no/always trio 로 fallback.
- **Apple 동적 키보드 단축키**: `MonitorScreen.KeyboardShortcutsModifier` 에서 ⌘Y/⌘N 하드바인딩 제거. 대신 현재 `options.shortcut` 을 매칭하고(⌘y/⌘n/⌘a/⌘v/⌘d 등 파서가 라벨에서 추론한 값), 없으면 인덱스 기반 ⌘1..⌘9 fallback. 옵션 없으면 defensive 하게 ⌘Y/⌘N 유지. ⌘. (interrupt) / ⌘Return ("go on") 은 awaiting 여부와 무관하게 유지.
- **Android e-ink 게이트 (핵심)**: `android/.../MonitorScreen.kt:722` 의 popup 호출 조건에 `!EinkDetector.isEinkDevice()` 추가. e-ink 기기는 popup 자체를 숨기고, 기존 "크리처 옆 물음표" static indicator 만 유지. 태블릿/폰/macOS 에서만 interactive popup 이 뜬다. `EinkDetector` 는 이미 CremaS/Onyx/Kobo/Pantone/Boyue/PocketBook/reMarkable/Supernote/Bigme/Dasung/Hisense/MOAAN 까지 판별한다 (`android/.../util/EinkDetector.kt:44-59`).
- **Android 동적 렌더**: `AttentionTheaterHUD.kt` 도 동일 패턴 — 수평 Row vs 수직 LazyColumn(max 260dp) 분기. `AttentionFeatured` data class 에 `options`/`promptType`/`cursorIndex`/`navigable` 필드 추가하고 `buildAttentionFeatured()` 가 DashboardState 에서 그대로 실어 넘김.
- **Parser 커버리지 검증**: `bridge/src/__tests__/output-parser.test.ts` 에 3 종 fixture 추가 — (1) 5-옵션 plan approval (라벨 "Approve and start in auto mode" 등), (2) OpenClaw scope 선택 (user/project/session), (3) OAuth grant 2-버튼. 기존 `OPTION_NUMBERED` regex 가 이미 셋 다 cleanly 파싱해서 parser 수정은 불필요했다.

### 핵심 설계 결정
- **Popup 에 multi-step wizard 상태 기계를 새로 만들지 않는다.** Scope → Token → Submit 같은 hierarchical 흐름은 bridge 가 step 별로 `option_prompt` 이벤트를 emit 하므로 (각 step 에서 Claude Code TUI 가 다른 옵션 세트를 보여줌), popup 은 "현재 step 의 옵션 집합" 만 그리면 된다. UI 에 step chain 을 유지할 이유가 없다 — `state.options` 가 매번 교체될 뿐.
- **E-ink 는 popup 을 완전히 숨긴다.** 사용자 확인: "크리처 옆 물음표 그정도면 충분하다". 대안(static 배지, 2-option degraded 모드) 대신 완전 suppress 선택. e-ink 에서 입력을 받으려면 사용자는 태블릿/폰/Mac 으로 옮겨가면 되고, 크리처 "?" 가 이미 그 신호를 전달한다.
- **Fallback trio 는 유지한다.** 파서가 빈 options 배열과 함께 `AWAITING_PERMISSION` 을 emit 하는 edge case (라벨 추출 실패) 에서 popup 이 blank 가 되는 것을 막기 위해 Yes/No/Always 3버튼으로 degrade. 이전 하드코딩 경험이 누적되어 있는 defensive 안전망.
- **팔레트 이원화**: 수평 레이아웃은 index-based 색(green=0, red=1, cyan=2) 로 tool-approval 의 시각 기억을 유지하고, 수직 레이아웃은 semantic-based 색(recommended=green, deny=red, 기본=중립) 으로 긴 옵션 리스트에서 "default choice" 가 어디인지 즉시 보이게 했다.

### 검증
- `pnpm vitest run bridge/src/__tests__/output-parser.test.ts` — 200/200 통과 (신규 fixture 3건 포함).
- `xcodebuild -scheme AgentDeck_macOS` — BUILD SUCCEEDED.
- `xcodebuild -scheme AgentDeck_iOS -destination 'generic/platform=iOS Simulator'` — BUILD SUCCEEDED.
- `pnpm test:android` — 82/82 Android JUnit 통과.
- 실제 popup 동작(plan 5-option / OpenClaw scope / e-ink suppress) 은 다음 세션 또는 사용자 수동 QA — memory rule `feedback_verify_visual_output.md` 에 따라 screencap-verify 필요.

---
