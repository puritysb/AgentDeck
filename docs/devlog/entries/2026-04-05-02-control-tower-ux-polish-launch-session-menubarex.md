# 2026-04-05 — Control Tower UX polish + Launch Session + MenuBarExtra 구조 재설계

### 문제
1. Control Tower 세션 카드가 sparse — model name/activity time/creature 아이콘 없음, rate limit 트렌드 없음, idle 3개 초과 시 collapse
2. 대시보드에서 크리처 클릭 시 같은 세션이 두 번 렌더 ("세션이 하나 더 생김")
3. MLX 리스트에서 nanoLLaVA가 깜빡거림 (나타났다 사라졌다)
4. Launch Session 버튼 클릭 후 터미널 안 열림 (AppleScript Automation 권한 미요청)
5. Launch Session이 특정 폴더/에이전트/터미널 선택 없이 고정 실행
6. MenuBarExtra + `.sheet` 조합에서 클릭 이벤트 불안정

### 해결
**Control Tower 개선** (`ControlTowerPanel.swift`):
- Creature SF Symbol 아이콘 (water.waves/ladybug/cloud/terminal/server.rack)
- 세션 row 서브타이틀: `agentType · modelName · 23m`
- Rate limit ↑↓ 트렌드 화살표 (1% 이상 변화 시), >70% 시 reset time orange+semibold
- Idle collapse 제거 (항상 개별 row)
- 세션 row 탭 → `focusSession` + 대시보드 열기
- 헤더: `N sessions · M active · K attention` 색상 코딩
- `previousFiveHourPercent`/`previousSevenDayPercent` state 필드 추가, usage_update 처리 전에 이전값 보존

**크리처 중복 버그 수정** (`TerrariumState.swift`):
- 원인: Focus relay가 sibling의 state_update를 broadcast하면 client `state.agentType`이 "daemon"→"claude-code"로, `sessionId`가 sibling의 id로 바뀜. `primaryIsOctopus=true`되어 primary 문어 추가하는데 siblings 리스트에 같은 id가 여전히 있어서 이중 렌더
- 해결: octopus/jellyfish/opencode 각각 `primaryIsX && $0.id == sessionId` 조건 시 siblings에서 제외

**MLX nanoLLaVA 깜빡임 수정** (`DaemonServer.swift`):
- 원인: Focus relay broadcast 핸들러가 modelCatalog/ollamaStatus는 daemon 캐시로 override하지만 mlxModels는 pass-through. 오래된 sibling bridge(필터 없는 구버전)의 state_update가 nanoLLaVA 포함 리스트 전송 → daemon의 자체 프로브(5초 주기, 필터 적용)와 번갈아 덮어쓰면서 flicker
- 해결: focus relay `setBroadcast` 핸들러에서 `state_update`의 `mlxModels`를 항상 `self.cachedMlxModels`로 override (empty면 key 제거)

**Launch Session dialog 신규 구현**:
- MenuBarExtra + `.sheet` 문제: `.menuBarExtraStyle(.window)` 위의 sheet는 focus/click event 전달 불안정 (feedback-assistant#331, Peter Steinberger 검증)
- 해결: 독립 `Window("Launch Session", id: "launch-session")` scene 선언 + `openWindow(id:)` + `NSApp.activate(ignoringOtherApps:)` (menu bar 앱 default `.accessory` policy)
- 폴더 picker (NSOpenPanel) + 에이전트 segmented (Claude/Codex/OpenCode/Plain) + 터미널 menu (Terminal/iTerm2/Alacritty/WezTerm/Ghostty/Warp)
- 터미널 자동 감지: `NSWorkspace.urlForApplication(withBundleIdentifier:)` — 설치된 것만 목록에 표시
- 실행 방식: iTerm2는 AppleScript (탭 생성 + write text), 나머지는 `.command` 파일 + `NSWorkspace.open(file, withApplicationAt: appURL)`
- `@AppStorage`로 마지막 폴더/에이전트/터미널 기억

**SessionLauncher PATH discovery**:
- App Sandbox PATH가 제한적 → `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, `~/Library/pnpm`, `~/.npm-global`, `~/.nvm/current` 경로 명시적 체크 후 fallback `which`

### 핵심 설계 결정
- **Secondary windows from MenuBarExtra**: sheet ❌, 독립 `Window` scene ✅. `openWindow(id:)` + `NSApp.activate()` 필수
- **Focus relay state override**: sibling의 데이터 중 daemon이 권위 있는 것(mlxModels, modelCatalog, ollamaStatus, gatewayAvailable)은 **항상 daemon 캐시로 덮어쓴다** — sibling의 구버전/다른 필터를 신뢰하지 않음
- **Creature layout + focus relay 상호작용**: Focus relay가 primary 상태를 바꿀 때 siblings 리스트에서 ID 중복 제거는 UI가 책임진다 (프로토콜 레벨에서 제거하지 않음 — 여러 클라이언트가 다른 관점에서 해석 가능해야 함)
- **Terminal 실행**: AppleScript는 Automation 권한 프롬프트 필요 → 실패 가능. `.command` 파일 + `NSWorkspace.open`은 sandbox-safe + 사용자 기본 터미널 존중

### 후속 이슈 (해결 — 35b1f45)
- **Settings 진입점 중복** ✅: `MonitorScreen` gear 버튼을 macOS에서 `showSettingsWindow:` selector 경유로 통일 (`openSettings()` 헬퍼 + `#if os(macOS/iOS)` 분기). iOS는 `.sheet` 유지
- **`openDashboard` window 검색** ✅: `title.contains()` 제거. SwiftUI `openWindow(id:)` 이미 존재 window를 front로 가져오므로 fallback 자체가 불필요 — `openWindow(id:)` + `NSApp.activate` 2줄로 축소, `openLaunchSession`도 동일 처리. i18n-safe

---
