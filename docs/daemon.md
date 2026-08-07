---
id: arch.daemon
title: Daemon Hub
description: The singleton daemon on port 9120 — session-bridge push, mDNS recovery, usage relay, multi-surface monitoring.
category: Engineering
locale: en
canonical: true
status: stable
owner: Bridge maintainers
reviewed: 2026-07-22
revision: 2026-07-22
source_of_truth: docs/daemon.md
validators: [pnpm test, agentdeck daemon status]
---
# Daemon Hub Architecture

The daemon is the **sole hub** for all dashboard clients. Session bridges never advertise mDNS or serve external WS/SSE — all external devices connect via daemon only.

## Role split — CLI vs Swift in-process daemon

AgentDeck runs two daemon implementations that are **not competitors but collaborators**. Ports coordinate via singleton guard (first-to-bind wins 9120) and the Swift app transparently falls back to WS-client mode when the CLI is already up.

| 책임 | 담당 | 근거 |
|---|---|---|
| Claude/Codex/OpenCode PTY 스폰 | **CLI** | sandbox 가 사용자 binary 실행 제한 (Apple 2.5.2) |
| OpenClaw Gateway 인증 (Keychain 토큰) | **Swift app** | Shared Keychain Access Group 설계 상 in-process 필요 |
| D200H 상태/제어 | **Ulanzi Studio plugin** | 공식 plugin이 daemon WS에 연결; AgentDeck daemon은 HID를 직접 열지 않음 |
| Pixoo HTTP 스트리밍 | Swift app **또는** CLI | 둘 다 가능. 현재 Swift 에서. |
| Timebox Mini Light BLE | **포트 소유자** | CLI(Node) 데몬이 `timeboxDevices` 를 발견하면 `sync_ble.py`(bleak)를 **자동 spawn**해 구동. 단독 Swift 앱이면 CoreBluetooth 로 네이티브 구동. 둘 다 뜨면 CLI 데몬 소유, Swift stand down (BLE 단일연결). 구 Bluetooth Classic SPP 변종은 제거됨 |
| iDotMatrix BLE | **포트 소유자** | CLI(Node) 데몬이 포트를 쥐면 데몬이 `sync.py`(Python bleak)를 **자동 spawn**해 구동(Node는 BLE 네이티브 불가). 단독 Swift 앱(CLI 없음)이면 Swift 가 CoreBluetooth(hub 모듈)로 구동. 둘 다 뜨면 CLI 데몬이 소유, Swift 는 stand down |
| ESP32 serial | Swift app **또는** CLI | 둘 다 가능 |
| iPad/Web WS 허브 | 먼저 바인드한 쪽 | CLI 우선 (PTY 가 있으니 세션 있음), 없으면 Swift |
| mDNS 광고 | 먼저 바인드한 쪽 | 동일 |
| 세션 집계 + 상태 브로드캐스트 | **CLI 있을 때**, 없으면 Swift | singleton guard |

**CLI 없이 Swift 앱만 실행한 경우**: port 9120 은 Swift daemon 이 잡고 완결된
Tier 1 모니터링 허브로 동작한다. 사용자가 명시적으로 활성화한 Claude/Codex hook,
OpenCode SSE, OpenClaw Gateway 이벤트가 세션을 만들고, 같은 daemon 이 iPad pairing,
Device Preview, APME Layer 2, Pixoo/ESP32/BLE device I/O를 서비스한다. D200H는 Ulanzi
Studio plugin이 WS로 연결된 경우에만 나타난다. 이 경로는 PTY를 spawn하거나 조향
선택지를 만들어내지 않으며, 그런 Tier 2 기능은 외부 CLI daemon이 제공한다. App Store
UI는 CLI 전용 섹션을 숨기고 companion executable 설치를 유도하지 않는다.

**외부 CLI daemon 이 이미 실행 중인 경우**: `DaemonService.alreadyRunning` → `connectToExternalDaemon`. Swift 앱은 죽지 않고 CLI daemon 의 WS 클라이언트가 된다 (`isUsingExternalDaemon = true`). 이 모드는 사용자가 터미널에서 별도 daemon 을 이미 운영하는 고급 경로이며, App Store 앱 자체는 외부 실행 파일 설치/기동을 요구하지 않는다. 하드웨어 상태는 CLI daemon 이 `state_update.moduleHealth` 로 브로드캐스트한 범위만 UI 에 표시한다.

**iDotMatrix BLE 구동 주체**: CLI(Node) 데몬이 포트를 소유하면 데몬이 부팅 시 `startIDotMatrixSync(port)`로 npm 패키지에 포함된 `bridge/src/idotmatrix/sync.py`(bleak)를 **자식 프로세스로 자동 spawn**한다(라이프사이클 관리: 크래시 시 backoff 재spawn, 데몬 종료 시 kill). Python 의존성은 npm 설치 중 받지 않고, 첫 BLE 명령 또는 `agentdeck ble setup` 때 `~/.agentdeck/python-ble`에 준비한다. 데몬 시작 자체는 네트워크 설치를 하지 않으며 런타임이 준비되지 않았으면 명시적인 setup 안내를 로그에 남긴다. 이로써 **CLI 데몬만 떠 있어도**(Swift 앱·수동 `idotmatrix sync` 불필요) 준비된 기기가 구동된다. sync.py 는 `/pixoo/frame?size=32`를 폴링해 BLE push. — 단독 Swift 앱(CLI 데몬 없음)일 때만 Swift 가 hub 모듈로 직접 구동하고, **CLI 데몬이 있으면 Swift client-mode 는 stand down**(`DaemonService.syncClientModeDevices`가 client 모드 BLE 구동을 띄우지 않음) → BLE 단일연결 충돌 방지. Pixoo/D200H/ESP32 도 CLI 가 소유.

**Timebox Mini Light 구동 주체**: CLI(Node) 데몬이 `timeboxDevices` 설정을 발견하면 `startTimeboxSync(port)`로 npm 패키지에 포함된 `bridge/src/timebox/sync_ble.py`(bleak)를 **자식 프로세스로 자동 spawn**한다(iDotMatrix 와 동일 라이프사이클·`~/.agentdeck/python-ble` 런타임). 사용자는 `agentdeck timebox scan` 으로 런타임 준비와 검색을 한 번에 수행하고 `TimeBox-mini-light` BLE 주소를 `agentdeck timebox add <address>`로 등록한다. sync_ble.py 는 `/pixoo/frame?size=11&layout=micro`를 폴링해 ISSC transparent-UART(`49535343-…`)로 GATT write. 단독 Swift 앱일 때는 CoreBluetooth 로 네이티브 구동, CLI 데몬이 있으면 Swift client-mode stand down (BLE 단일연결). 구 Bluetooth Classic SPP 변종(`sync.py`)은 호환성·App Store 제약으로 제거됨.

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

4단계 — (1) `readDaemonInfo()` from `~/.agentdeck/daemon.json` (PID alive 검증) (2) `findExistingDaemon()` from `sessions.json` fallback (3) `probeDaemonHealth()` HTTP `/health` probe (default port에 응답하는 daemon 감지) (4) `scanDaemonPortWindow()` — 9120–9139 전 구간 `/health` 병렬 sweep. (4)가 필요한 이유: App Store Swift daemon 의 `daemon.json` 은 sandbox private container 에 있어 Node 가 읽지 못하고, 일시적 9120 경합으로 daemon 이 fallback port (9121+) 에 앉아 있을 수 있다 — 파일/기본포트 검사만으로는 둘 다 놓쳐 split-brain (이중 mDNS 광고, Gateway/timeline 중복 relay, adb reverse flapping) 이 된다. `daemon-server.ts` + `cli.ts` + `daemon.ts`(legacy) 에서 체크. 기존 Node daemon 있으면 `process.exit(0)` (LaunchAgent KeepAlive 재시작 루프 방지); Swift daemon 이면 `/shutdown` 요청 후 `waitForDaemonExit()` 로 health 가 사라질 때까지 poll (고정 sleep 아님 — Swift 가 serial/ADB/BLE 모듈을 정리하기 전에 인수하면 tty/adb reverse 를 잠시 두 프로세스가 잡는다). Port occupied by non-daemon → auto-fallback to next available port.

## Shutdown timeout

`httpServer.close()` + 5s `setTimeout(() => process.exit(0))` — CLOSE_WAIT connections from disconnected clients can block `close()` callback indefinitely, causing zombie daemons (session bridge has 3s failsafe in `index.ts`).

## Autostart (login/logon)

- **macOS** — per-user **LaunchAgent** `dev.agentdeck.daemon` (`~/Library/LaunchAgents/`), `RunAtLoad=true`, `KeepAlive.SuccessfulExit=false`. `agentdeck daemon install` writes the plist + `launchctl load`; `uninstall` unloads + deletes it.
- **Windows** — per-user **Scheduled Task** `AgentDeckDaemon` with a **logon trigger**, registered via built-in `schtasks.exe` (no npm dependency, no admin elevation). `agentdeck daemon install` registers + immediately `/Run`s it and installs Codex hooks; `uninstall` gracefully `/shutdown`s the daemon then `/Delete`s the task. Builder + schtasks wrappers live in `bridge/src/windows-service.ts`; the pure XML builder is unit-tested in `bridge/src/__tests__/windows-service.test.ts` (the schtasks calls are integration-only).
  - **Why a Scheduled Task, not a Windows Service**: a real service runs in **session 0** with no desktop and restricted device access, which breaks USB-HID (D200H), audio (wake-word), mDNS, and the Stream Deck app. A logon task runs in the **interactive user session** — the exact analog of the macOS *per-user* LaunchAgent.
  - Task settings mirror the LaunchAgent: `LogonType=InteractiveToken` + `RunLevel=LeastPrivilege` (no elevation), `MultipleInstancesPolicy=IgnoreNew` (the singleton guard already dedupes), `RestartOnFailure` Interval=PT1M/Count=3 (≈KeepAlive), `ExecutionTimeLimit=PT0S`, no stop on idle/battery. Action runs `node.exe "<cli.js>" daemon start --foreground` so the task process **is** the daemon (lets RestartOnFailure track the real process).
  - The task XML is written **UTF-16LE + BOM** with an `encoding="UTF-16"` declaration — `schtasks /XML` rejects UTF-8 (`unable to switch the encoding`).
- **Linux** — per-user **systemd `--user` unit** `agentdeck-daemon.service` (`~/.config/systemd/user/`, honors `$XDG_CONFIG_HOME`). `agentdeck daemon install` writes the unit + `systemctl --user daemon-reload && enable`, then `start`s it and installs Codex/OpenCode hooks; `uninstall` gracefully `/shutdown`s the daemon then `disable --now` + removes the unit. Builder + systemctl wrappers live in `bridge/src/linux-service.ts`; the pure unit-file builder is unit-tested in `bridge/src/__tests__/linux-service.test.ts` (the systemctl calls are integration-only).
  - Unit mirrors the LaunchAgent: `Type=simple` + `ExecStart="<node>" "<cli.js>" daemon start --foreground` so the unit process **is** the daemon, `Restart=on-failure`/`RestartSec=5` (≈KeepAlive), `WantedBy=default.target`. `WorkingDirectory` uses the daemon's own data-dir resolver (`AGENTDECK_DATA_DIR` override, else `~/.agentdeck`) and `installUnit()` `mkdir -p`s that dir first, so systemd never fails at CHDIR on a fresh install. `hasSystemctl()` probes `systemctl --user is-system-running` first — on non-systemd distros or without a user D-Bus session, install degrades to a "run `agentdeck daemon start` manually" hint instead of failing.
  - **`AGENTDECK_DATA_DIR` is captured at install time**: when set, `agentdeck daemon install` persists it into the unit as an escaped `Environment="AGENTDECK_DATA_DIR=…"` directive (a systemd user manager does not inherit the install shell's environment after login/boot — without this the daemon would fall back to `~/.agentdeck` while systemd merely chdirs into the override, splitting state). `WorkingDirectory` and `Environment` derive from the same value; every generated value is escaped per-directive (`%%`, `$$` in ExecStart, `\"`/`\\` in quotes) and validated (absolute path, no control chars/edge whitespace) with actionable install-time errors. Re-run `agentdeck daemon install` to refresh the captured value; when unset, no `Environment=` line is emitted.
  - A user unit only auto-starts on login; for boot-without-login on a headless host the user runs `loginctl enable-linger $USER` once (surfaced as an install-time hint, not run automatically).
  - `daemon.json` discovery, port fallback, singleton guard, and graceful `/shutdown` are reused unchanged across all three platforms.

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

## LAN security model (issue #145)

The daemon deliberately binds `0.0.0.0` — companion apps, ESP32 boards, and pull-sync e-ink clients live on the LAN — so the security boundary is **authentication, not the bind address**:

- **HTTP default-deny** (`bridge/src/http-auth-gate.ts`, mirrored in Swift `DaemonServer.httpAccessResponse` + `HTTPServer.setAccessPolicy`): a request that is neither same-machine (`isLocalConnection`) nor token-bearing (`?token=` / `Authorization: Bearer`) reaches exactly one route — a minimal `GET /health` (`{status, mode, port, sameSocketControl, authRequired}`) with **no `pairingToken`, no module/device inventory, no session state**. Everything else 401s before route dispatch. The full `/health` (with `pairingToken`, for same-machine consumers) is only served to authorized requests.
- **Cross-origin reads go to one secret-free route, `GET /setup-status`** (`{status, mode, port, state, isSwift}`; Node `daemon-server.ts`, Swift `DaemonServer.setupHTTPRoutes`). It is the only route that answers with `Access-Control-Allow-Origin: *`, because the Ulanzi Studio Property Inspector is a webview on a foreign origin and its setup stepper has to tell "daemon down" from "daemon unreadable". **`/health` must never gain that header**: it carries `pairingToken`, and a browser request originates on the user's own machine, so it passes `isLocalConnection` — ACAO there would hand the LAN credential to any page the user visits. `/setup-status` is still behind the default-deny gate above (an unauthenticated LAN peer gets 401, not the payload); CORS governs which *origin* may read a response, not which *host* may ask.
- **WS auth on both daemons**: non-local WebSocket upgrades require the token (Node `ws-server.ts` closes 4001; Swift `WebSocketServer` rejects the handshake with 401 — added 2026-08-07, previously unauthenticated).
- **Discovery never carries the token** — both mDNS TXT and the UDP 9121 fallback beacon are visible to every peer on the segment. The beacon advertises `authRequired: true` (same semantics as the unauthenticated `/health`): discovery says "a daemon is here and pairing is required" and nothing more. Only the daemon hub advertises; session bridges do not expose per-project metadata. Clients that used to self-serve the credential pair explicitly instead: companions via QR (`agentdeck qr`) / manual URL, ESP32 boards via serial provisioning (`wifi_provision.authToken` → NVS), remote workers via `--daemon-token` / `AGENTDECK_DAEMON_TOKEN`.
- **Startup logs never carry the token-bearing pairing URL**. They direct the user to the explicit `agentdeck qr` command instead; this keeps the credential out of long-lived daemon log files.
- **Rotation**: `agentdeck token rotate` retires a leaked token (all paired clients re-pair). `agentdeck token show` prints it for provisioning.
- **Loopback-only opt-out**: `AGENTDECK_LOOPBACK_ONLY=1` binds `127.0.0.1` for users with no LAN devices. Startup logs state the bind mode either way.
- Tests: `bridge/src/__tests__/http-auth-gate.test.ts`, `mdns-hostname.test.ts` (TXT token absence), `discovery-security.test.ts` (UDP and startup-log absence), `ws-server-auth.test.ts`, Swift `HttpAccessPolicyTests`.

## Multi-surface monitoring

- mDNS (`_agentdeck._tcp`, daemon only), auth token (`~/.agentdeck/auth-token`), SSE (`/sse`), remote WS token validation
- `0.0.0.0` binding for LAN access (token-gated — see LAN security model above)
- `isLocalConnection()` recognizes localhost + machine's own IPs via `os.networkInterfaces()` — same-machine clients (macOS app, localhost) bypass token auth
- **Client discovery**: Local clients (TUI, CLI, session bridge) read `~/.agentdeck/daemon.json` for port (legacy App Group path is read as a fallback on macOS). The App Store Swift daemon's own `daemon.json` lives in its private sandbox container, which non-sandboxed Node processes deliberately do NOT read (TCC would hang them on a permissions dialog) — cross-implementation discovery of an App Store daemon therefore relies on the `/health` port probe: `findDaemonPortAsync()` and the daemon startup guard both sweep the 9120–9139 window. Swift paths always route through `AgentDeckPaths.swift`. Remote clients (Android, Apple iOS) use mDNS — only daemon advertises, so no preference logic needed
- **macOS App Sandbox**: App Store 빌드는 앱 sandbox container (`~/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/`) 로 **정상 read/write 가능** — 여기서 `daemon.json`/`sessions.json` 읽음. 차단되는 건 외부 홈 경로 (`~/.openclaw/`, `~/.codex/`, `/Library/pnpm/`) 뿐. macOS 는 실제로 mDNS 로 daemon 발견 (daemon만 광고하므로 단순)
- **Client count for polling**: `BridgeCore.hasClients()` = WS clients + external serial connections (`setExternalClientCountProvider`). All polling guards (sessions_list, usage, API) use `hasClients()` so ESP32 serial-only connections keep data flowing
- **ESP32 daemon state**: `isDaemon = agentType == "daemon" || "openclaw"` — daemon sends "openclaw" when gateway alive, renderer maps per-session octopus states from `sessions_list`. Multi-octopus particles (round-robin spawn from octStates[]), bubbles (exhale from all), session name dedup (`#1`/`#2`)

## Remote attach (cross-machine sessions)

A session bridge (`agentdeck claude` etc.) normally attaches only to a daemon on its own machine. With **opt-in** remote attach it can instead push to a daemon on another machine and be controlled from that machine's Stream Deck — the use case being "I run Claude Code on several boxes (often over SSH) but have one Stream Deck on a main node."

- **Enable**: `--remote-daemon` is THE opt-in switch. `--daemon-host <host[:port]>` only names the explicit endpoint (cross-subnet / SSH where multicast doesn't reach) and **requires the switch** — the recommended explicit form is `--remote-daemon --daemon-host mainnode.lan`. Env equivalents: `AGENTDECK_REMOTE_DAEMON=1`, `AGENTDECK_DAEMON_HOST` (alias `AGENTDECK_REMOTE_DAEMON_HOST`). Default is unchanged (local-only).
- **Opt-in gate (security boundary)**: remote attach never happens on ambient/inherited state — `--remote-daemon` / `AGENTDECK_REMOTE_DAEMON=1` gates **both** remote paths. A host hint given without the switch is inert (the CLI prints a pre-PTY warning via the shared `deriveRemoteAttachOpts` helper, so the derivations can't drift). Within the switch: an unreachable or capability-less named host returns null rather than falling through to mDNS, and mDNS is never consulted on any other signal. With no opt-in and no local daemon, `resolveDaemonTarget` returns null and the session stays local-only (byte-for-byte unchanged). Regression-tested in `bridge/src/__tests__/daemon-target.test.ts` (`resolveDaemonTarget precedence + opt-in gate`).
- **Resolution precedence** (`resolveDaemonTarget`, `session-registry.ts`): local daemon → explicit host → mDNS. A **capable** local daemon always wins — an explicit `--daemon-host` is then not consulted (ordinary local-preferred behavior). Under `--remote-daemon`, an **incapable** local daemon no longer short-circuits resolution: with a `--daemon-host` it falls through to probe the named host (so a tunnel or remote hub is reached instead of dead-ending); without one it warns once and refuses (no mDNS fallthrough — a deliberately-built `ssh -L` tunnel must fail loudly, not silently roam to another LAN daemon). On every reconnect the resolver's result — null included — **replaces** the client's cached target, so a daemon that disappears or is downgraded mid-lifecycle stops being dialed until a valid target resolves again.
- **Capability negotiation**: remote attach requires the main node to run the **Node CLI daemon**, which advertises `sameSocketControl: true` in `/health`. Under `--remote-daemon` **every** accepted target must advertise the flag — including a loopback one, since an `ssh -L` forward of a remote daemon is indistinguishable from a genuine local daemon by IP. The explicit-host path refuses (null + one-shot warning) a daemon lacking the flag; the mDNS confirm step filters such candidates out; `DaemonWsClient` additionally refuses to dial a capability-less target under remote intent (defense against resolver drift). The Swift (macOS app) daemon does not implement the push-channel control frames and is therefore never selected as a remote hub — without the switch, a worker attaching to it locally still just gets a plain (uncontrolled) push registration.
- **Discovery** (`bridge/src/mdns-discover.ts`): the consume side of `mdns.ts` — browses `_agentdeck._tcp`, reads TXT (`port`/`ip`; `token` is only present on pre-#145 daemons), rejects link-local/loopback, confirms each candidate via `/health` (keeps only `sameSocketControl` daemons). Mirrors the iOS/Android `BridgeDiscovery`.
- **Upward auth (session → daemon)**: `DaemonWsClient` connects `ws://<host>:<port>?token=<token>` for remote, `ws://127.0.0.1:<port>` for local. The URL (which can carry the token) is never logged — only host:port plus a token yes/no marker. **Token sourcing (issue #145)**: current daemons no longer serve their token to unauthenticated LAN peers, so the worker must be provisioned — `--daemon-token <token>` or `AGENTDECK_DAEMON_TOKEN` (value in `~/.agentdeck/auth-token` on the hub machine); a legacy daemon's advertised token remains the fallback. Without a token the resolver warns once with that hint and the hub rejects the socket.
- **Remote classification (`remoteAttach`)**: the worker's registration carries an explicit `remoteAttach: true` flag when the user opted in AND the target daemon advertises the capability. The daemon trusts the flag over the socket's source IP — an `ssh -L`-forwarded worker arrives on loopback and is indistinguishable from a local session by IP alone (the non-local-IP heuristic remains as back-compat for older workers). Handled by `bridge/src/session-push-channel.ts` (extracted, integration-tested).
- **Reverse control (daemon → session) — same-socket only**: the worker's outbound push socket is **bidirectional**. When the daemon focuses a remote session it sends command frames back **down the socket the worker already opened** — the daemon never dials back, so a NAT'd / SSH-only worker needs no inbound reachability at all. The daemon stores the live push socket (`remote-sessions.ts` `sender`, `getRemoteSender`); the focus relay drives it (`setSameSocketResolver`) with `session_command_down` frames. On focus it sends `session_focus_down` (worker emits an initial state snapshot up); the worker forwards its `RELAYED_EVENTS` back up as `session_event_up` while focused; unfocus sends `session_unfocus_down`. Commands run through the **same** `applyPluginCommand` handler the local WS server uses (`index.ts`), so local and remote control never diverge. A remote session with no live push socket is unreachable until its worker reconnects.
- **Sender-identity guards**: registration, state updates, event ingestion, and teardown are all keyed to the session's **registered sender socket**. A worker reconnect migrates focus to the new socket (`migrateSender`) before the old close fires; a stale socket's close, state push, or `session_event_up` cannot affect the newer registration; a worker ignores down-frames whose `sessionId` isn't its own. The guard covers the shared push-state **aggregator cache** too, not just the remote registry — in the local + `--remote-daemon` dual-registration case the sessions list dedups to the local row, whose displayed state comes from that cache.

## Supporting files

- `bridge/src/mdns.ts` — `bonjour-service` mDNS 광고 (`_agentdeck._tcp`), daemon only
- `bridge/src/mdns-discover.ts` — `bonjour-service` mDNS **browse** (remote-attach discovery), session bridge opt-in only
- `bridge/src/remote-sessions.ts` — daemon-side in-memory registry of cross-machine sessions (live push socket + display host/port), pruned on push-socket close
- `bridge/src/session-push-channel.ts` — extracted push-channel handler (`session_push_register`/`session_push_state`/`session_event_up`) with remote classification + sender-identity guards
- `bridge/src/auth.ts` — `~/.agentdeck/auth-token` 32-char hex 토큰, local bypass, constant-time validation, `rotateToken()`
- `bridge/src/http-auth-gate.ts` — LAN default-deny 정책 (pure functions: `isAuthorizedHttpRequest`/`gateHttpRequest`/`buildPublicHealth`)
- `bridge/src/session-registry.ts` — `daemon.json` port discovery (`writeDaemonInfo`/`readDaemonInfo`/`removeDaemonInfo`/`findDaemonPort`/`probeDaemonHealth`)
- `bridge/src/hook-server.ts` — SSE (`/sse`), `/health` (includes `mode` field), `/status`, 토큰 인증
- `bridge/src/ws-server.ts` — remote WS 연결 토큰 검증 (4001 거부), local bypass
