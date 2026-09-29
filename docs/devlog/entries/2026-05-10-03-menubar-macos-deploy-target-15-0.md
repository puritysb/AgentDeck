# 2026-05-10 — Menubar 패널 정리 + macOS deploy target 15.0

### 문제

메뉴바 ControlTowerPanel 에 누적된 6 가지 사용자 체감 결함:

1. OpenClaw 행에 uptime 이 `20582d` 로 표기 — 가상 `openclaw-gateway`
   세션이 `startedAt` 을 `1970-01-01` placeholder 로 인젝트해서
   `displayRelativeTime` 이 epoch 차이를 일 단위로 계산.
2. TOPOLOGY hub 의 `AgentDeck` 과 `:9120` 이 두 줄로 쌓여 popover
   세로공간 낭비.
3. 패널이 `.frame(height: 620)` 로 고정돼 디바이스 수와 무관하게 동일
   높이 + 내부 ScrollView 가 항상 활성.
4. Launch Session 진입점 (pill, empty-state 버튼, MonitorEmptyGuide
   카피, Window scene, dialog 파일) 이 dead path 로 잔존.
5. Dashboard 가 단순 `openWindow(id:)` 만 호출 — 메뉴바에서 닫을 수
   없고 시각적 활성/비활성 표시 없음.
6. Evaluation/Settings 가 macOS window-restoration 으로 재실행 시
   다시 떠 사용자 의도와 어긋남.

### 해결

- **OpenClaw uptime**: `DaemonServer` 에 `gatewayConnectedAt: Date?`
  필드 추가, connect 시점 기록 + 모든 disconnect 경로에서 nil 클리어.
  `buildSessionsListEvent` 가 nil 이면 `startedAt` 를 dict 에 넣지
  않아 시간 chip 이 그냥 안 보이도록 함.
- **TOPOLOGY 한 줄**: `MenuBarTopologyList.hubNode` 의 inner
  `VStack(spacing: 0)` → 단일 `HStack(.firstTextBaseline)`. 포트 폰트
  9.5→11pt 로 가독성 보강.
- **DOWNSTREAM 동적 사이즈**: ControlTowerPanel `height: 620` 제거,
  inner VStack 에 `.fixedSize(vertical: true)`, ScrollView 외부에
  `.frame(maxHeight: scrollContentMaxHeight)` (= visibleFrame * 0.85
  - 140pt chrome). 디바이스가 적으면 패널이 줄고, 30+ 인 극단에서만
  내부 스크롤이 등장.
- **Launch 제거**: ControlTowerPanel 의 pill·empty-state 버튼·helper
  4 곳 + AgentDeckApp 의 `Window("Launch Session")` scene + MonitorEmptyGuide
  의 Launch 버튼/카피 + `LaunchSessionDialog.swift` 파일 + APP_REVIEW_NOTES
  / AquariumSurface 주석까지 일괄 정리. companion-install prompt 위반
  소지를 차단하기 위해 빈 sessions 카피도 "Sessions appear here
  automatically once the bridge picks one up." 식의 neutral 문구로 통일.
- **Dashboard 토글**: `@State dashboardVisible` + 5s timer +
  NSWindow Notification 4종 (didBecomeKey/willClose/didMiniaturize/
  didDeminiaturize) 옵서버. pill 이 활성 시 `Dashboard ●` (primary
  fill) / 비활성 시 `Dashboard` (outline). 클릭으로 open/close 토글.
- **Evaluation/Settings 자동 복구 차단**: 두 `Window` scene 에
  `.defaultLaunchBehavior(.suppressed)` 적용. 이 modifier 가 macOS 15+
  전용이라 deploy target 을 14 → 15 로 상향. 동시에 AquariumSurface
  의 `if #available(macOS 15.0, *)` 게이트 1 곳 정리.

### macOS 15.0 deploy target 변경의 영향

- **사용자 영향**: macOS Sonoma (14.x) 에 머무는 사용자는 다음 빌드
  부터 App Store 업데이트를 받지 못한다. CI 는 이미 `macos-15` runner
  사용 중이라 빌드 인프라는 그대로.
- **iOS deploy target (17.0) 은 변경 없음** — iOS companion 영향 없음.
- **App Store Connect 의 minimum OS 표기**도 다음 release 업로드 시
  자연 반영. 메타데이터·release notes 는 본 차수 업로드 직전에
  "Requires macOS Sequoia 15 이상" 명시 필요.
- **하향 호환 경로**: `defaultLaunchBehavior(.suppressed)` 만 떼면
  14 호환은 회복 가능. 다만 6번 이슈는 AppDelegate
  `applicationDidFinishLaunching` 의 windows orderOut fallback 이 또
  필요해진다.

### 검증

- `xcodegen` 으로 project.yml → pbxproj 재생성, `MACOSX_DEPLOYMENT_TARGET = 15.0`
  두 build config 모두 반영 확인.
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS
  -configuration Debug -destination "platform=macOS,arch=arm64" build`
  통과 (BUILD SUCCEEDED, 경고 없음, App Store Helper Guard 통과).
- `grep -rn "launch-session|openLaunchSession|LaunchSessionDialog" apple/` → 0 건.
- Codex adversarial review (verdict: needs-attention) — 두 high finding
  (timeline dedup, focus_session validation) 은 본 PR 영역 밖 선행
  변경 결함으로 분리. macOS 14 drop 은 본 entry 로 의도 + 영향 명시.

---
