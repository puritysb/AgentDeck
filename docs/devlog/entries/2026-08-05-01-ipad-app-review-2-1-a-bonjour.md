# 2026-08-05 — iPad App Review 2.1(a): 지속 Bonjour를 무한 로딩으로 표시한 상태 모델 수정

### 문제
iPhone/iPad 첫 제출 `1.0.2 (3901)`가 2026-08-04 App Review에서
Guideline 2.1(a)로 거절됐다. iPad Air 11-inch (M3), iPadOS 26.5.2의
리뷰 네트워크에는 AgentDeck Mac이 없었고, 10초 foreground auto-connect
poll은 이미 끝났는데 화면은 `Searching for AgentDeck...`와 `ProgressView`를
계속 표시했다. 원인은 `BridgeDiscovery.isSearching`이 **사용자에게 보이는
bounded search**가 아니라 나중에 나타나는 Mac도 잡기 위한 **long-lived
NWBrowser ready 상태**였는데, ConnectionOverlay가 둘을 같은 의미로 사용한 것.
실패 안내와 스피너가 동시에 보이는 리뷰 스크린샷은 이 불일치를 그대로 증명했다.

### 해결
- `ConnectionOverlayPhase`를 도입해 permission denied / reconnecting /
  connecting / foreground searching / not found를 명시적으로 분리했다.
  activity indicator는 `isAutoConnecting` 또는 실제 socket connecting일 때만
  보이고, 10초 종료 뒤에는 `No AgentDeck found on this network` terminal state로
  전환된다. Bonjour browser는 백그라운드에서 계속 살아 있어 late Mac auto-connect는
  유지된다.
- no-Mac 상태에 Search Again, manual URL, **Explore without a Mac**을 제공했다.
  기존에 iOS 타깃까지 컴파일되지만 진입점이 없던 Device Preview를 full-screen으로
  열었다. iPad에서는 macOS식 한 줄 toolbar 대신 **Preview Setup + device canvas**
  두 카드로 배치하고, iPhone에서는 같은 카드가 세로로 쌓인다. 선택기 줄바꿈을
  정돈하고 작은 장치 프리뷰를 확대했으며, Mac이 없을 때는 혼동을 주는 Live 토글
  대신 Offline sample 상태를 표시한다. 계정·Mac·agent session·hardware 없이 로컬
  Swift synthetic renderer만 쓴다.
- Debug 전용 `-AgentDeckDisableDiscovery`를 추가해 개발 Mac daemon을 끄지 않고도
  Simulator에서 결정적인 empty-network 화면을 캡처할 수 있게 했다. Release에서는
  컴파일되지 않는다.
- `APP_REVIEW_NOTES.md`에 iOS 전용 1,442자 Notes block과 Resolution Center 답변,
  clean-iPad 검증 절차를 추가하고 metadata/feature matrix/TestFlight QA/submission
  checklist를 같은 계약으로 갱신했다.
- 전체 Apple 테스트에서 발견된 기존 weight 정렬 테스트 기대값도 정본 순서
  (openclaw → claude-code → codex-cli)에 맞췄다. 제품 정렬 구현은 변경하지 않았다.

### 2차 보완 — 남아 있던 같은 클래스의 무한 인디케이터
1차 수정은 스피너를 `discovery.isSearching`에서 `isAutoConnecting`으로 옮겼지만,
`isAutoConnecting`을 false로 되돌리는 곳이 **연결 성공 / 10초 poll giveup /
preferred bridge / 프로세스 종료** 뿐이었다. 즉 attempt 를 끝내는 다른 경로가
지표를 끄지 않았다. 재현: auto-connect 가 브리지를 찾아 `connectTo(bridge)` 하면
poll 타이머만 죽고 `isAutoConnecting` 은 true 로 남는다 → 연결 실패로 reconnect
사다리 진입 → 사용자가 화면의 **Stop Reconnecting** 을 누르면
`connection.disconnect()` 는 소켓만 내리고 waterfall 은 stage 가 남는다 →
phase `.searching` → **스피너 무한 + 복구 버튼 미표시**, 게다가 `Search Again` 은
`guard waterfallStage == .idle` 에 걸려 no-op. 앱 재시작 외 탈출구가 없었다.

- **deadline 을 구조적 보증으로**: `beginForegroundSearch()`/`endForegroundSearch()`
  로 `isAutoConnecting` 쓰기를 단일 창구로 모으고, waterfall 1회당 하나의
  `foregroundSearchDeadline`(기본 12s, 10s poll 바로 위)이 어느 stage 든 상관없이
  지표를 끈다. 소켓은 건드리지 않으므로 진행 중인 연결은 자기 `.connecting`
  phase 를 유지한 채 계속 성공할 수 있다. 앞으로 exit 경로가 늘어도 각 경로를
  감사할 필요가 없다.
- **사용자 중단 = 복구 가능 상태**: `stopConnectionAttempts()` 를 도입해
  Stop Reconnecting / Settings → Disconnect 가 타이머·지표·stage 를 함께 정리하고,
  `retryConnectionWaterfall()` 은 stage 가드를 무시하고 항상 재시작한다
  (Search Again 이 죽은 버튼이 되지 않도록).
- **명시적 중단이 유지되도록** `userStoppedConnecting` 을 추가해 late-discovery
  sink 가 다음 mDNS tick 에 사용자의 중단을 되돌리지 못하게 했다. 새로운 connect
  intent 가 플래그를 해제한다.
- **`onReconnectExhausted` 가 실패 URL 을 파라미터로** 받는다. 기존에는 같은
  main-queue 블록이 `connection.url = nil` 을 먼저 실행해 핸들러의 ghost-bridge
  blacklist 조회가 **항상 미스**했고, 죽은 mDNS 엔트리가 계속 재시도됐다.
- **시작 전 프레임**: `hasStartedForegroundSearch` 를 추가해
  `ContentView.onAppear` 가 waterfall 을 걸기 전 한 프레임이 "No AgentDeck found"
  실패 상태로 렌더되지 않게 했다. waterfall 을 view appearance 로 시작하지 않는
  macOS 는 `true` 로 출발한다.
- **회귀 게이트를 실제 메커니즘에 걸었다**: `ConnectionOverlayPhase.resolve` 테스트는
  입력을 그대로 반영하는 함수라 "isAutoConnecting 이 영영 true" 인 위 결함을
  원리적으로 잡지 못한다. `ForegroundSearchBoundTests` 가 실제 `AgentStateHolder`
  를 (deadline 주입 + Debug 브라우저 kill-switch 로) 구동해 지표가 항상 멈추고
  항상 사용자에게 행동 여지를 남기는지 검증한다. `BridgeDiscovery` 의 capture
  kill-switch 를 `var isBrowserEnabled` 로 바꿔 테스트가 launch argument 없이도
  빈 네트워크를 재현하고 CI 에 Local Network 프롬프트를 띄우지 않게 했다.
- Review Notes / Resolution Center 답변 / TestFlight QA(B6·B7 추가)를 실제 동작에
  맞춰 갱신했다. late-discovery auto-connect 는 이미 구현돼 있었고
  (`discovery.$bridges` sink), 문구도 그대로 유효하다.

### 검증
- iPad Air 11-inch (M3) Simulator: no-Mac 10초 뒤 spinner 없음, terminal state 및
  responsive two-card offline Device Preview 실제 클릭/렌더 확인
- iOS XCTest: 127 tests 통과, 1 skip
- macOS XCTest: 491 tests 통과, 1 skip
- 2차 보완 후 macOS XCTest: 496 tests 통과, 1 skip (신규 5건 포함)
- `pnpm docs:check` 통과
- `bash scripts/build-apple-release.sh --ios` — signed Release archive/export 성공,
  `verify-appstore-archive.sh` 통과, `dist/agentdeck-ios-v1.0.2.ipa` 생성

---
