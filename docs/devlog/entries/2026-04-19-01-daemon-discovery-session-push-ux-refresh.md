# 2026-04-19 — Daemon discovery 통합 + session_push 핸들러 + UX refresh

### 문제

App Store macOS 앱 실행 후 터미널에서 `agentdeck claude` 를 띄우면 세션이 대시보드에 나오지 않았다. 실측 상태:
- Swift daemon: group container 의 `daemon.json` 에 port 9120 기록
- `~/.agentdeck/daemon.json`: 없음
- CLI 세션: `~/.agentdeck/sessions.json:9121` 으로 등록
- Swift daemon: `fetchUsageRelayed: 0 siblings`, `BROADCAST sessions_list: 0 sessions`

세 레이어 버그가 합쳐진 상태:
1. Node CLI 는 `~/.agentdeck` 만 봐서 group container 의 Swift daemon 을 못 찾음
2. Swift daemon 은 sandbox 로 `~/.agentdeck` 를 못 읽음
3. 세션 브릿지가 WS 로 보내는 `session_push_register` 를 Swift daemon 의 `handleCommand` 가 type 만 로그하고 버림 (핸들러 부재)

인접 이슈:
- `CreatureClaudeCode.imageset/claudecode.svg` 가 Google Antigravity 로고 + `<title>Antigravity</title>` 라벨. lobe-icons 에서 파일 착각
- Android + ESP32 + Pixoo 의 가재 크리처가 `gatewayAvailable` 기반 → 미인증 상태에서도 가재 표시
- App Store 빌드에서 Claude 사용량이 "No data" 만 뜨고 사유 불명 (OAuth 토큰 Anthropic 정책상 접근 불가)
- OpenClaw 토큰 입력 UI 가 특정 auth 상태에서만 노출 → 첫 실행 유저 진입 경로 없음

### 해결

**Daemon discovery 통합 (`bridge/src/session-registry.ts`)**
- `getCandidateDataDirs()` 신설. 우선순위: `AGENTDECK_DATA_DIR` → `~/.agentdeck` → macOS group container
- `readSessions` / `readDaemonInfo` / `findExistingDaemon` 이 후보 dir 순회. 쓰기는 자기 dir 만 (sandbox 경계 존중)
- `findDaemonPortAsync()` — registry miss 시 9120-9139 `/health` probe. Swift 의 `httpPort` 필드 respect

**세션 브릿지 async port provider (`daemon-ws-client.ts` + `index.ts`)**
- `portProvider` 가 async 반환 허용. `doConnect()` async 화. registry 비어있어도 probe 로 daemon 발견

**Hook shell snippet 3 경로 통합**
- `@agentdeck/hooks` 의 `buildHookCommand(event)` 가 단일 소스. `setup/src/setup.ts` inlined copy + `HookInstaller.swift` 가 byte-identical snippet emit
- 런타임 순서: `$AGENTDECK_PORT` → `~/.agentdeck/daemon.json` → group container → `httpPort`/`port` 선호 → `/health` probe → 9120 fallback

**Swift daemon session_push 핸들러 (`DaemonServer.swift`)**
- `pushedSessionsById` map 추가 — filesystem registry 와 분리
- `handleCommand` 최상단에 `session_push_register` / `session_push_state` 인터셉션 (Node daemon 의 `onRawMessage` 등가)
- `handleSessionPushRegister` → upsert + 즉시 `broadcastSessionsList()`
- `handleSessionPushState` → state/modelName 패치 + broadcast
- `refreshSessions()` 가 filesystem + pushed 병합 후 enrichSessionsWithState → probe 실패한 pushed 항목 자동 prune

**Crayfish 게이팅 통일 (4 플랫폼)**
- Mac `TerrariumState.swift`, Android `TerrariumState.kt` + `TopologyRail.kt`, ESP32 `agent_state.h/protocol.cpp/renderer.cpp/matrix_pages.cpp/hud_bar.cpp`, Pixoo `PixooRenderer.swift` + `PixooModule.swift` 전부 `gatewayConnected` 기반으로 통일
- Android Protocol 에 `gatewayConnected` 필드 신설
- ESP32 DashboardState 에 `bool gatewayConnected` 추가 + state_update JSON 파싱

**macOS Dashboard UX refresh**
- `SetupNeededCard` 신규 — Claude quota / OpenClaw token / hook consent 미설정 항목을 한 카드로 + "Open Settings →" 바로가기
- `AttentionTheaterHUD` + `TopologyRail` (`TankStatusPanel` + `DeviceDiagnosticPanel` 대체)
- `ControlTowerPanel.rateLimitsSection` — "No data" → 상태별 actionable 메시지
- `SettingsScreen` — OpenClaw 토큰 편집기 App Store 빌드에서 상시 노출 + Attribution 링크

**브랜드/IP 정리**
- `CreatureClaudeCode` SVG → lobe-icons Claude 아이콘 (`<title>Claude</title>`)
- `ATTRIBUTION.md` 신규: lobe-icons MIT + 상표 고지 + 비관계 선언
- `README.md` + `docs/appstore-metadata-draft.md` 에 non-affiliation disclaimer (App Store 5.2.5 대비)

### 검증
- `pnpm -r build` — Done (bridge + hooks + setup + shared + plugin)
- `xcodebuild -scheme AgentDeck_macOS / AgentDeck_iOS build` — SUCCEEDED
- `pnpm vitest run bridge/src` — 703/703 pass
- ESP32 4 보드 (round_amoled / ips_35 / ulanzi_tc001 / box_86) 전부 SUCCESS
- Android `./gradlew :app:assembleDebug` — BUILD SUCCESSFUL
- Runtime 로그 확인: `[Daemon] session_push_register: <id> port=9121 agent=claude-code` 발화 + `[D200H] BROADCAST sessions_list: 0 → 1 sessions`

### 핵심 설계 결정

- **Option A: Mac 앱이 daemon hub 우선** — Mac 앱 있으면 Swift daemon 이 9120 소유. CLI `agentdeck daemon start` 는 감지 후 exit. `agentdeck claude` 는 세션 bridge 만 스폰해서 기존 daemon 에 붙음. Mac 앱 없는 유저만 `agentdeck daemon install` (LaunchAgent)
- **Write-strict / read-lenient** — 각 프로세스는 자기 소속 dir 에만 쓰고 (Swift=group container, Node=~/.agentdeck) read 만 cross-dir. sandbox 경계 불침범 + 시야 확장
- **WS-push 를 1급 discovery path 로 격상** — Swift 는 `~/.agentdeck/sessions.json` 을 영구적으로 못 읽음. filesystem 동기화 대신 `session_push_register` 를 authoritative registration mechanism 으로. Idempotent 재등록 + `/health` probe 실패 시 prune
- **Crayfish 는 가용성이 아니라 인증의 signal** — `gatewayAvailable` 는 "프로세스 reachable" 의미로 topology row 에만. 크리처는 `gatewayConnected` 트리거. 4 플랫폼 동일 규칙
- **App Store 에서 Claude subscription quota 읽기는 합법 경로 없음** — Anthropic 2026-02-20 정책: subscription OAuth 를 3rd-party 툴에 쓰면 ToS 위반. Setup 카드가 "Install AgentDeck CLI" 로 정직하게 안내
- **Option A 는 CLI-only 배포와 호환** — Mac 앱 없는 유저는 기존 `agentdeck daemon start/install` 경로 그대로 작동. "Mac 앱 있으면 우선" 이지 "없으면 불가" 가 아님

---
