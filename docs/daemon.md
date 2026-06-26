# Daemon Hub Architecture

The daemon is the **sole hub** for all dashboard clients. Session bridges never advertise mDNS or serve external WS/SSE — all external devices connect via daemon only.

## Role split — CLI vs Swift in-process daemon

AgentDeck runs two daemon implementations that are **not competitors but collaborators**. Ports coordinate via singleton guard (first-to-bind wins 9120) and the Swift app transparently falls back to WS-client mode when the CLI is already up.

| 책임 | 담당 | 근거 |
|---|---|---|
| Claude/Codex/OpenCode PTY 스폰 | **CLI** | sandbox 가 사용자 binary 실행 제한 (Apple 2.5.2) |
| OpenClaw Gateway 인증 (Keychain 토큰) | **Swift app** | Shared Keychain Access Group 설계 상 in-process 필요 |
| D200H HID 통신 | **Swift app** | `com.apple.security.device.usb` entitlement 은 sandbox 안에서 열림 |
| Pixoo HTTP 스트리밍 | Swift app **또는** CLI | 둘 다 가능. 현재 Swift 에서. |
| Timebox Mini Light BLE | **포트 소유자** | CLI(Node) 데몬이 `timeboxDevices` 를 발견하면 `sync_ble.py`(bleak)를 **자동 spawn**해 구동. 단독 Swift 앱이면 CoreBluetooth 로 네이티브 구동. 둘 다 뜨면 CLI 데몬 소유, Swift stand down (BLE 단일연결). 구 Bluetooth Classic SPP 변종은 제거됨 |
| iDotMatrix BLE | **포트 소유자** | CLI(Node) 데몬이 포트를 쥐면 데몬이 `sync.py`(Python bleak)를 **자동 spawn**해 구동(Node는 BLE 네이티브 불가). 단독 Swift 앱(CLI 없음)이면 Swift 가 CoreBluetooth(hub 모듈)로 구동. 둘 다 뜨면 CLI 데몬이 소유, Swift 는 stand down |
| ESP32 serial | Swift app **또는** CLI | 둘 다 가능 |
| iPad/Web WS 허브 | 먼저 바인드한 쪽 | CLI 우선 (PTY 가 있으니 세션 있음), 없으면 Swift |
| mDNS 광고 | 먼저 바인드한 쪽 | 동일 |
| 세션 집계 + 상태 브로드캐스트 | **CLI 있을 때**, 없으면 Swift | singleton guard |

**CLI 없이 Swift 앱만 실행한 경우**: port 9120 은 Swift daemon 이 잡고, 세션 0 개 상태로 pairing/device I/O 만 서비스. iPad 가 붙어서 "Device Preview + Setup card" 를 보고, D200H/Pixoo/ESP32 는 idle 상태로 대기한다. 이게 사용자가 "CLI 설치 유도" 만 보이는 상태의 의미.

**외부 CLI daemon 이 이미 실행 중인 경우**: `DaemonService.alreadyRunning` → `connectToExternalDaemon`. Swift 앱은 죽지 않고 CLI daemon 의 WS 클라이언트가 된다 (`isUsingExternalDaemon = true`). 이 모드는 사용자가 터미널에서 별도 daemon 을 이미 운영하는 고급 경로이며, App Store 앱 자체는 외부 실행 파일 설치/기동을 요구하지 않는다. 하드웨어 상태는 CLI daemon 이 `state_update.moduleHealth` 로 브로드캐스트한 범위만 UI 에 표시한다.

**iDotMatrix BLE 구동 주체**: CLI(Node) 데몬이 포트를 소유하면 데몬이 부팅 시 `startIDotMatrixSync(port)`로 `bridge/src/idotmatrix/sync.py`(bleak)를 **자식 프로세스로 자동 spawn**한다(라이프사이클 관리: 크래시 시 backoff 재spawn, 데몬 종료 시 kill). 설정된 `idotmatrixDevices`가 없거나 `.venv`가 없으면 no-op. 이로써 **CLI 데몬만 떠 있어도**(Swift 앱·수동 `idotmatrix sync` 불필요) 기기가 구동된다. sync.py 는 `/pixoo/frame?size=32`를 폴링해 BLE push. — 단독 Swift 앱(CLI 데몬 없음)일 때만 Swift 가 hub 모듈로 직접 구동하고, **CLI 데몬이 있으면 Swift client-mode 는 stand down**(`DaemonService.syncClientModeDevices`가 client 모드 BLE 구동을 띄우지 않음) → BLE 단일연결 충돌 방지. Pixoo/D200H/ESP32 도 CLI 가 소유.

**Timebox Mini Light 구동 주체**: CLI(Node) 데몬이 `timeboxDevices` 설정을 발견하면 `startTimeboxSync(port)`로 `bridge/src/timebox/sync_ble.py`(bleak)를 **자식 프로세스로 자동 spawn**한다(iDotMatrix 와 동일 라이프사이클). 사용자는 `agentdeck timebox scan` 으로 `TimeBox-mini-light` BLE 주소를 찾아 `agentdeck timebox add <address>`로 등록한다. sync_ble.py 는 `/pixoo/frame?size=11&layout=micro`를 폴링해 ISSC transparent-UART(`49535343-…`)로 GATT write. 단독 Swift 앱일 때는 CoreBluetooth 로 네이티브 구동, CLI 데몬이 있으면 Swift client-mode stand down (BLE 단일연결). 구 Bluetooth Classic SPP 변종(`sync.py`)은 호환성·App Store 제약으로 제거됨.

## Gateway 플래그 의미

`state_update` 이벤트의 3개 gateway 관련 플래그는 각자 역할이 다르다:

- **`gatewayAvailable`** — OpenClaw 프로세스가 `localhost:18789` 에 listen 중. 토폴로지 row 표시용 (Mac `ControlTowerPanel`, `TopologyRail`, Android `TopologyRail`)
- **`gatewayConnected`** — OpenClaw Gateway 에 **인증 성공**. 가재 크리처 렌더링 gate. Mac 터레리움, Android 터레리움, ESP32 firmware (`renderer.cpp`), Pixoo64 (`PixooRenderer.swift`), 모든 HUD 바가 이 플래그로 가재 표시 여부를 결정
- **`gatewayHasError`** — 인증 실패/프로토콜 에러. SICK 가재 + ERROR row 로 surfaces


## Port ownership

Daemon owns port **9120** (default, fallback to 9121+ if occupied by non-daemon). All dashboard clients (Android, Apple, ESP32, TUI, Plugin) connect exclusively to daemon. Session bridges use ports 9121–9139 for internal hook HTTP only (`AGENTDECK_PORT` env var injected into Claude process).

`~/.agentdeck/daemon.json` stores `{ port, pid, startedAt, httpPort? }` for local client discovery (written on daemon bind, removed on shutdown). Remote clients discover via mDNS (daemon only advertises `_agentdeck._tcp`).

## Server implementations

- **Node.js daemon**: single `http.createServer()` handles HTTP + WS upgrade on one port
- **Swift daemon**: single raw TCP `NWListener` — detects HTTP vs WebSocket upgrade per connection, manual WebSocket frame parsing (RFC 6455 GUID `258EAFA5-E914-47DA-95CA-C5AB0DC85B11`), Bonjour `NWListener.Service` attached to same listener for mDNS. `getpwuid(getuid())` for real home directory (bypasses App Sandbox container path redirect). `httpPort` in `DaemonInfo` for mixed setups where HTTP ≠ WS port (nil when unified)

## Daemon singleton guard

3단계 — (1) `readDaemonInfo()` from `~/.agentdeck/daemon.json` (PID alive 검증) (2) `findExistingDaemon()` from `sessions.json` fallback (3) `probeDaemonHealth()` HTTP `/health` probe (port에 응답하는 daemon 감지). `daemon-server.ts` + `cli.ts` + `daemon.ts`(legacy) 세 곳에서 체크. 기존 daemon 있으면 `process.exit(0)` (LaunchAgent KeepAlive 재시작 루프 방지). 이중 daemon으로 인한 Gateway 이벤트 중복 relay, mDNS 충돌, timeline 중복 방지. Port occupied by non-daemon → auto-fallback to next available port.

## Shutdown timeout

`httpServer.close()` + 5s `setTimeout(() => process.exit(0))` — CLOSE_WAIT connections from disconnected clients can block `close()` callback indefinitely, causing zombie daemons (session bridge has 3s failsafe in `index.ts`).

## Whisper-server

Uses fixed singleton port **9100** (`~/.agentdeck/whisper-server.json` info file for discovery, last session exit kills server).

## Session timeline relay

`SessionTimelineRelay` (`session-timeline-relay.ts`) — daemon subscribes to sibling session bridges' WS to relay `timeline_event`/`timeline_history` events + `state_update.modelCatalog` (Claude Code OAuth catalog → daemon `cachedModelCatalog`, merged with Gateway catalog by name dedup). 10s sync interval detects new/removed sessions. Eliminates client-side `StateTimelineGenerator` duplication (Android/Apple) — daemon provides unified timeline stream for all agent types.

## mDNS crash recovery + IP change detection

`bonjour-service` multicast errors (`EADDRNOTAVAIL` on sleep/wake, WiFi reconnect, VPN toggle) are caught in `bridge-core.ts` `uncaughtException` handler. `invalidateMdnsInstance()` nulls the Bonjour instance, then `mdns.ts` recovery timer (30s interval) detects null + LAN IP available → re-publishes `_agentdeck._tcp` service automatically. Recovery timer also detects IP changes (DHCP renewal) and re-publishes with the new IP. Session bridges never advertise mDNS (`cli.ts` hardcodes `mdns: false`). **Apple discovery**: `BridgeDiscovery.swift` ignores TXT `ip` field (can be stale from Bonjour cache) and always uses `NWConnection` endpoint resolution for live IP. iOS waterfall: mDNS first → savedUrl fallback after 4s (same as macOS).

## Daemon usage relay

Daemon `fetchUsageRelayed()` — (1) sibling bridge `GET /usage` HTTP 중계 (2) WS 연결로 `usage_update` 이벤트 수신 (3) sibling 없을 때만 직접 API. Sibling 있으면 직접 API 호출 안 함 (429 방지). Bridge `hook-server.ts` `GET /usage` 엔드포인트 (no auth, local only).

## Gateway connection 격리

Daemon이 Gateway adapter의 `connection` 이벤트를 WS 클라이언트에 포워딩하지 않음 — 클라이언트가 자신의 bridge 연결 끊김으로 오인하는 버그 방지. Gateway 상태는 `state_update.gatewayAvailable`과 `sessions_list`로 전달. `disconnectGatewayAdapter()`도 `connection:disconnected` 미전송.

## Gateway health check

두 가지 경로가 빌드별로 나뉜다:

- **Node.js 브릿지 (CLI/Homebrew)** — `checkGatewayHealth()` in `bridge/src/gateway-probe.ts`. `openclaw doctor --json` 을 30초 간격 폴링. warn/error 감지 시 `gatewayHasError: true` 를 `state_update` 에 포함.
- **Swift 인프로세스 다이몬 (App Store macOS)** — `apple/AgentDeck/Daemon/Gateway/GatewayProbe.swift` 의 `checkHealth()` 는 App Store 빌드에서 subprocess 불가 (Apple 2.5.2) → **`openclaw doctor` 호출 없음**. TCP probe 로 reachability 만 확인하고, 인증 완료된 health 는 `OpenClawAdapter` 의 Gateway `health` RPC/event 로 받는다.

두 경로 모두 `gatewayHasError` 가 true 이면 Android 가재가 SICK 상태로 전환 (탈색, 기울기, 늘어진 집게). Gateway 미접속 시 폴링 스킵.

## isDaemonLike 패턴

모든 클라이언트(TUI/Android/Apple)에서 세션 목록 렌더링 시 `agentType == 'daemon' || sessions.any { it.agentType == agentType }` 체크. daemon이 Gateway 연결 시 `agentType='openclaw'`로 브로드캐스트하므로 sessions_list에 동일 타입이 있으면 daemon 모드로 처리 (primary 스킵, sessions만 렌더). 이 없으면 session bridge 모드 (primary + siblings 렌더).

## Focus relay authority

- **Terrarium creature focus relay 중복 방지**: Focus relay가 sibling state_update를 broadcast하면 client `state.sessionId`가 sibling id로 바뀌고 `agentType`도 변경됨 → primary 크리처 추가되는데 siblings 리스트에 동일 id가 남아있어 이중 렌더. `TerrariumState.toTerrariumState()`에서 `primaryIsOctopus && $0.id == sessionId` 필터 적용 (octopus/jellyfish/opencode 모두)
- **MLX mlxModels focus relay override**: focus relay broadcast 핸들러가 modelCatalog/ollamaStatus는 daemon 캐시로 덮어쓰지만 mlxModels는 pass-through → 오래된 sibling bridge(필터 없음)가 nanoLLaVA 리스트 전송 시 깜빡임. Focus relay의 `setBroadcast`에서 `state_update`의 `mlxModels`를 항상 daemon's `cachedMlxModels`로 덮어쓰기

## Multi-surface monitoring

- mDNS (`_agentdeck._tcp`, daemon only), auth token (`~/.agentdeck/auth-token`), SSE (`/sse`), remote WS token validation
- `0.0.0.0` binding for LAN access
- `isLocalConnection()` recognizes localhost + machine's own IPs via `os.networkInterfaces()` — same-machine clients (macOS app, localhost) bypass token auth
- **Client discovery**: Local clients (TUI, CLI, session bridge) read `~/.agentdeck/daemon.json` (or `~/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/daemon.json` for App Store build; legacy App Group path is read as a fallback) for port. Swift paths always route through `AgentDeckPaths.swift`. Remote clients (Android, Apple iOS) use mDNS — only daemon advertises, so no preference logic needed
- **macOS App Sandbox**: App Store 빌드는 앱 sandbox container (`~/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/`) 로 **정상 read/write 가능** — 여기서 `daemon.json`/`sessions.json` 읽음. 차단되는 건 외부 홈 경로 (`~/.openclaw/`, `~/.codex/`, `/Library/pnpm/`) 뿐. macOS 는 실제로 mDNS 로 daemon 발견 (daemon만 광고하므로 단순)
- **Client count for polling**: `BridgeCore.hasClients()` = WS clients + external serial connections (`setExternalClientCountProvider`). All polling guards (sessions_list, usage, API) use `hasClients()` so ESP32 serial-only connections keep data flowing
- **ESP32 daemon state**: `isDaemon = agentType == "daemon" || "openclaw"` — daemon sends "openclaw" when gateway alive, renderer maps per-session octopus states from `sessions_list`. Multi-octopus particles (round-robin spawn from octStates[]), bubbles (exhale from all), session name dedup (`#1`/`#2`)

## Supporting files

- `bridge/src/mdns.ts` — `bonjour-service` mDNS 광고 (`_agentdeck._tcp`), daemon only
- `bridge/src/auth.ts` — `~/.agentdeck/auth-token` 32-char hex 토큰, local bypass, constant-time validation
- `bridge/src/session-registry.ts` — `daemon.json` port discovery (`writeDaemonInfo`/`readDaemonInfo`/`removeDaemonInfo`/`findDaemonPort`/`probeDaemonHealth`)
- `bridge/src/hook-server.ts` — SSE (`/sse`), `/health` (includes `mode` field), `/status`, 토큰 인증
- `bridge/src/ws-server.ts` — remote WS 연결 토큰 검증 (4001 거부), local bypass
