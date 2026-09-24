---
id: arch.daemon
title: Daemon Hub
description: The singleton daemon on port 9120 — session-bridge push, mDNS recovery, usage relay, multi-surface monitoring.
category: Specs
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

> **Managed PTY compatibility:** the CLI PTY-spawn row is a compatibility
> capability, not the default architecture. `agentdeck claude|codex|opencode`
> and `agentdeck monitor` remain functional with no removal date. Replacement
> design is discussed in
> [Discussion #278](https://github.com/puritysb/AgentDeck/discussions/278) and
> implementation gates live in
> [#273](https://github.com/puritysb/AgentDeck/issues/273). Daemon-first hook and
> event observation is the supported path for new workflows.

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

### Preferred port vs actual port

두 개는 다른 사실이고, 섞으면 폴백이 영구화된다.

- **Preferred port** = 이 데몬이 서비스하려는 포트, 곧 *의도*. `-p/--port` › `AGENTDECK_DAEMON_PORT` › `settings.json` 의 `daemonPort` › 9120 순으로 해석된다 (`bridge/src/daemon-port.ts`). macOS 앱의 `AppPreferences.daemonPort` 와 같은 역할이고 같은 이름이다.
- **Actual port** = 실제로 bind 에 성공한 포트, 곧 *결과*. `daemon.json` 이 이것을 기록하고 모든 클라이언트가 여기로 해석한다.

**의도는 영속화하고 결과는 절대 영속화하지 않는다.** 시작 경로의 어떤 코드도 `daemonPort` 를 쓰지 않는다 — 사용자만 `agentdeck daemon port <n>` 로 쓴다. 결과를 적어버리면 자기강화가 된다: 14초짜리 커널 예약에 밀려 9121 에 앉은 데몬이 9121 을 기록하고 영원히 거기서 시작한다.

```bash
agentdeck daemon port          # 해석된 포트 + 출처 + 저장값 + 실제 서비스 중인 포트
agentdeck daemon port 9200     # settings.json 에 저장 (다음 restart 부터 적용)
agentdeck daemon port --clear  # 저장값 삭제 → 기본 9120 으로 복귀
```

저장값은 autostart 유닛에도 자동으로 적용된다 — LaunchAgent / Scheduled Task / systemd 는 `daemon start --foreground` 를 `-p` 없이 실행하고, 데몬이 시작 시점에 다시 해석하기 때문이다. (posture 플래그는 반대로 argv 에 구워야 한다. 그쪽은 파일이 아니라 명령줄에만 존재하는 사실이기 때문.)

### 선호 포트를 잠깐 뺏겼을 때 — 기다린다, 포기하지 않는다

선호 포트가 bind 되지 않고 `/health` 에도 응답이 없으면 원인은 아직 알 수 없다. macOS 의 커널 예약이나 반열림 소켓이 한 원인일 수 있지만, 무응답만으로 확정하지 않는다. #370에서는 기존 20초 대기가 끝난 뒤 폴백으로 내려갔고, 최초 대기 시작 약 58초 뒤 재시작이 선호 포트 바인딩에 성공했다. 이는 포트 해제 시각이나 NECP 원인을 확정한 측정은 아니다.

시작 중에는 `preferredPortReclaimBudgetMs`에 따라 macOS에서 최대 90초, 다른 플랫폼에서 최대 20초 동안 **실제 HTTP 리스너와 지정된 bind 주소**로 재시도한다. 성공하면 그 리스너를 그대로 유지하므로 검사 소켓을 닫고 다시 bind하는 틈이 없다. 매 실패마다 점유자를 다시 확인하여, 대기 중 같은 사용자의 다른 데몬이 시작되면 종료하고 다른 사용자의 데몬은 건드리지 않는다. 한도까지 실패하면 폴백 포트와 선호 포트를 로그로 알린다.

이 변경은 시작 시점의 완화책이다. 이미 폴백 포트에서 서비스하는 데몬과 연결된 장치를 자동으로 재시작하거나 이동시키지 않는다. 90초보다 긴 점유는 여전히 폴백할 수 있으며, 실제 App Store 앱과 장치를 연결한 양방향 전환 검증은 #370에서 별도로 추적한다.

폴백 상태는 `agentdeck daemon status` 가 알려주고(선호 포트와 실제 포트가 다를 때만), `agentdeck daemon restart` 가 선호 포트를 다시 겨냥한다 — restart 는 **실행 중인 실제 포트에서 posture 를 읽고 stop 한 뒤, 선호 포트로 start** 한다. 예전에는 9120 을 맹목적으로 probe 했기 때문에 데몬이 폴백 포트에 있으면 posture 를 못 읽었고, "posture 없음" 은 "개방 posture" 와 구별되지 않아 enterprise 설정이 조용히 풀렸다.

## Server implementations

- **Node.js daemon**: single `http.createServer()` handles HTTP + WS upgrade on one port
- **Swift daemon**: single raw TCP `NWListener` — detects HTTP vs WebSocket upgrade per connection, manual WebSocket frame parsing (RFC 6455 GUID `258EAFA5-E914-47DA-95CA-C5AB0DC85B11`), Bonjour `NWListener.Service` attached to same listener for mDNS. `getpwuid(getuid())` for real home directory (bypasses App Sandbox container path redirect). `httpPort` in `DaemonInfo` for mixed setups where HTTP ≠ WS port (nil when unified)

## Daemon singleton guard

4단계 — (1) `readDaemonInfo()` from `~/.agentdeck/daemon.json` (PID alive 검증) (2) `findExistingDaemon()` from `sessions.json` fallback (3) `probeDaemonHealth()` HTTP `/health` probe (default port에 응답하는 daemon 감지) (4) `scanDaemonPortWindow()` — 9120–9139 전 구간 `/health` 병렬 sweep. (4)가 필요한 이유: App Store Swift daemon 의 `daemon.json` 은 sandbox private container 에 있어 Node 가 읽지 못하고, 일시적 9120 경합으로 daemon 이 fallback port (9121+) 에 앉아 있을 수 있다 — 파일/기본포트 검사만으로는 둘 다 놓쳐 split-brain (이중 mDNS 광고, Gateway/timeline 중복 relay, adb reverse flapping) 이 된다. `daemon-server.ts` + `cli.ts` + `daemon.ts`(legacy) 에서 체크. 기존 Node daemon 있으면 `process.exit(0)` (LaunchAgent KeepAlive 재시작 루프 방지 — 단 CLI 층에서는 그 데몬이 **다른 빌드**를 서빙 중일 때만 예외로 인수한다, 아래 § 어떤 빌드가 포트를 잡고 있는가); Swift daemon 이면 `/shutdown` 요청 후 `waitForDaemonExit()` 로 health 가 사라질 때까지 poll (고정 sleep 아님 — Swift 가 serial/ADB/BLE 모듈을 정리하기 전에 인수하면 tty/adb reverse 를 잠시 두 프로세스가 잡는다). Port occupied by non-daemon → auto-fallback to next available port.

이 sweep 범위는 `--port-window <lo-hi>` (또는 `AGENTDECK_PORT_WINDOW=9200-9209`) 로 바꿀 수 있다. 용도는 하나뿐이다 — **운영 데몬 옆에서 일회용 데몬을 띄워 검증하는 것**. sweep 이 창 전체를 훑고 살아있는 Node daemon 을 만나면 `process.exit(0)` 하므로, `AGENTDECK_DATA_DIR` 로 데이터 디렉토리를 분리하고 `-p` 로 포트를 지정해도 격리 데몬은 뜨지 못했다(가드 자체는 올바른 동작). **기본 창을 벗어난 데몬은 9120–9139 를 훑는 클라이언트에게 보이지 않는다** — 명시 host/port 로만 닿는다. 그래서 `daemon start` 는 창이 기본값이 아닐 때 그 사실을 반드시 출력한다. 파싱 불가한 값은 조용히 무시되지 않고 **기본 창으로 되돌아간다** — 잘못된 창이 split-brain 가드를 무력화해서는 안 되기 때문이다.

## 어떤 빌드가 포트를 잡고 있는가 (dev checkout)

`/health` 는 `build` — 그 데몬이 **기동할 때 로드한** JS 트리(`bridge/dist` + `shared/dist` + `hooks/dist`)의 내용 해시 12자 — 를 실어 보낸다. 이유는 하나다: source checkout 에서 `agentdeck` 은 `bridge/dist/cli.js` 를 가리키는 shim 이고 그 파일은 **제자리에서 덮어써진다**. 리빌드 이전에 뜬 데몬은 디스크에 더 이상 존재하지 않는 바이트를 계속 실행하면서 pid·port·package version 을 리빌드 이후에 뜬 데몬과 똑같이 보고한다 — 즉 "already running" 과 "네가 방금 갈아치운 코드가 아직 돌고 있다" 를 구별할 방법이 없었다(2026-08-24 실측: 04:19 에 뜬 데몬이 19:20 리빌드 뒤에도 9120 을 점유).

- 해시는 **mtime 이 아니라 내용** 이다. `tsc` 는 매 실행마다 산출물을 다시 쓰므로 mtime 기반이면 아무것도 바뀌지 않은 리빌드가 "다른 빌드" 로 읽히고, 멀쩡한 데몬을 재시작시킨다.
- 데몬은 이 값을 **기동 시 한 번 캡처하고 다시 계산하지 않는다**(`startupBuildId`). 요청 시점에 다시 계산하면 누군가 리빌드한 순간부터 "최신 빌드" 를 보고하게 되는데, 그게 바로 이 필드가 탐지하려던 상태다.
- `daemon start` 는 자기 소유의 Node 데몬이 **다른** 빌드를 서빙 중이면 `exit 0` 대신 그 데몬을 세우고 포트를 인수한다. 단 **양쪽 해시를 모두 알 때만** — 이 필드 이전 데몬은 `build` 를 보내지 않고, 정보 없음을 근거로 축출하면 모든 start 가 restart 가 된다(autostart 유닛 포함). `--no-upgrade` 로 끈다. 소유권 게이트가 우선이라 **다른 사용자의 데몬은 빌드가 낡았어도 건드리지 않는다**.
- fallback 포트(9121+)에 앉은 데몬도 같은 판정을 받는다 — `daemon.json`/`sessions.json` 로 찾은 데몬 역시 `negotiateIncumbentDaemon` 을 거친다. 규칙이 "누가 그 데몬을 찾았는가" 에 따라 달라지면 안 되기 때문.

빌드 자체를 최신으로 만드는 쪽은 CLI 가 담당한다. checkout 에서 `daemon start` / `daemon restart` 는 stale 패키지를 먼저 빌드하고 **자기 자신을 re-exec** 한다(옛 `cli.js` 를 이미 로드한 프로세스가 잠시 뒤 새 `daemon-server.js` 를 동적 import 하는 혼합 빌드를 만들지 않기 위해). 세 가지 경계가 있다:

- **터미널이 붙어 있을 때만** 빌드한다. autostart 경로(LaunchAgent/Scheduled Task/systemd)는 stdio 가 로그 파일이고, 거기서 빌드에 실패하면 `KeepAlive` 재시작 루프가 된다. 그 경우엔 사실만 로그에 적고 있는 빌드로 뜬다. `--build` 로 강제, `--no-build` 로 금지.
- stale 판정(`findStaleSources`)은 **한 방향으로만 신뢰한다**. "src 가 dist 보다 새것이 아니다" 는 확실하므로 컴파일러를 건너뛰어도 되지만, 반대 방향은 과보고한다 — `shared` 는 composite 프로젝트라 rebase/worktree 전환/`touch` 로 mtime 만 움직이면 `tsc` 는 `.tsbuildinfo` 조차 다시 쓰지 않는다. 그래서 최종 판정은 빌드 전/후 **해시 델타** 로 한다: 델타가 없으면 re-exec 도 없고 경고도 없다.
- 빌드가 실패하면 **시작하지 않는다**(exit 1). 여기서 그냥 뜨면 방금 "빌드가 필요하다" 고 말해놓고 이전 빌드를 조용히 대신 실행하는 셈이다.

## Shutdown timeout

`httpServer.close()` + 5s `setTimeout(() => process.exit(0))` — CLOSE_WAIT connections from disconnected clients can block `close()` callback indefinitely, causing zombie daemons (session bridge has 3s failsafe in `index.ts`).

## Autostart (login/logon)

- **macOS** — per-user **LaunchAgent** `dev.agentdeck.daemon` (`~/Library/LaunchAgents/`), `RunAtLoad=true`, `KeepAlive.SuccessfulExit=false`. `agentdeck daemon install` writes the plist + `launchctl load`; `uninstall` unloads + deletes it.
- **Windows** — per-user **Scheduled Task** `AgentDeckDaemon` with a **logon trigger**, registered via built-in `schtasks.exe` (no npm dependency, no admin elevation). `agentdeck daemon install` registers + immediately `/Run`s it and installs Codex hooks; `uninstall` gracefully `/shutdown`s the daemon then `/Delete`s the task. Builder + schtasks wrappers live in `bridge/src/windows-service.ts`; the pure XML builder is unit-tested in `bridge/src/__tests__/windows-service.test.ts` (the schtasks calls are integration-only).
  - **Why a Scheduled Task, not a Windows Service**: a real service runs in **session 0** with no desktop and restricted device access, which breaks USB-HID (D200H), audio (wake-word), mDNS, and the Stream Deck app. A logon task runs in the **interactive user session** — the exact analog of the macOS *per-user* LaunchAgent.
  - Task settings mirror the LaunchAgent: `LogonType=InteractiveToken` + `RunLevel=LeastPrivilege` (no elevation), `MultipleInstancesPolicy=IgnoreNew` (the singleton guard already dedupes), `RestartOnFailure` Interval=PT1M/Count=3, `ExecutionTimeLimit=PT0S`, no stop on idle/battery.
  - **The action is a launcher, not the daemon**: `node.exe "<cli.js>" daemon autostart` spawns `daemon start --foreground` detached (`detached` + `windowsHide` → DETACHED_PROCESS | CREATE_NO_WINDOW) and exits. Task Scheduler attaches a console to an interactive-token action and no task setting suppresses it, so an action that *is* the daemon left a terminal window — and a taskbar button — on the desktop for as long as the daemon ran. Measured on Windows 11 26200 with Windows Terminal as the default terminal app, 2026-09-14: a long-lived `node.exe` action produced a visible `WindowsTerminal` window titled with its command line; `<Hidden>true</Hidden>` did **not** suppress it (that setting only hides the task in the Task Scheduler UI); `conhost --headless` did not run the action at all; and an `S4U` principal — the usual "no window" answer — cannot be registered without elevation (`schtasks /Create` → "Access is denied") and would put the daemon back in a non-interactive session, which is what a Windows Service is rejected for above. The launcher exits in a few hundred ms, before the terminal handoff paints: no visible window 0.7s or 5s after `schtasks /Run`, with the detached daemon serving.
  - **Four consequences of that split**, all handled in code.
    1. The task's `Status` now describes the launcher, so `Ready` is the steady state of a *healthy* machine and says nothing about the daemon. The daemon answers instead: the launcher passes `AGENTDECK_SUPERVISOR=schtasks`, the daemon stamps `startedBy` into `daemon.json` **after** it wins the port, and `supervisorJobRunning` reads that stamp whenever the status is `Ready` (`composeSchtasksRunning` + `schtasksOwnsRegisteredDaemon`). The stamp has to be written by the daemon, not the launcher: a launcher-recorded pid was tried first and reported a daemon that was alive only because it was *conceding* to an incumbent as supervised, so an install over an unsupervised daemon converged nothing (measured 2026-09-14). An absent stamp — hand-started daemon, Swift daemon, pre-stamp build — reads as "not supervised", which is the `unsupervised` / `no-daemon` side of the truth table and exactly what install converges.
    2. `daemon install` ends a running task instance before `/Run`. With `MultipleInstancesPolicy=IgnoreNew`, a `/Run` against an instance of the *previous* action is ignored silently (rc 0), so on the upgrade from an action that was the daemon itself the newly registered launcher never ran and the console-window daemon kept serving — an install that reported success and changed nothing (measured 2026-09-14). Under the launcher action there is no instance to end, so this is a migration step exactly once.
    3. **Every child process the daemon spawns must pass `windowsHide`.** A console-less parent's console child gets a *new* console, and a new console has a window unless the spawn sets CREATE_NO_WINDOW — so the day the launcher shipped, an empty `C:\Windows\system32\taskkill.exe` window began appearing every five minutes from the Codex rate-limit probe's cleanup kill (the same gap existed in the `adb reverse` poll). While the action was the daemon this was invisible: children inherited the daemon's own console and drew nothing. Measured two-arm from a console-less detached parent, 12 spawns each: without `windowsHide` 138 window sightings, with it 0. Gated by `bridge/src/__tests__/windows-child-window.test.ts`, which accepts a call only if it hides its window, runs a binary that cannot exist on Windows, or carries an inline `windows-hide-exempt:` reason.
    4. `RestartOnFailure` covers only a launcher that cannot spawn — a crashed daemon returns at the next logon or via `agentdeck daemon start`, the same as after a `schtasks /End`. `daemon stop` is unchanged: it ends the task (a no-op against a finished launcher) and then POSTs `/shutdown`, which is what actually stopped the daemon before as well.
  - The task XML is written **UTF-16LE + BOM** with an `encoding="UTF-16"` declaration — `schtasks /XML` rejects UTF-8 (`unable to switch the encoding`).
- **Linux** — per-user **systemd `--user` unit** `agentdeck-daemon.service` (`~/.config/systemd/user/`, honors `$XDG_CONFIG_HOME`). `agentdeck daemon install` writes the unit + `systemctl --user daemon-reload && enable`, then `start`s it and installs Codex/OpenCode hooks; `uninstall` gracefully `/shutdown`s the daemon then `disable --now` + removes the unit. Builder + systemctl wrappers live in `bridge/src/linux-service.ts`; the pure unit-file builder is unit-tested in `bridge/src/__tests__/linux-service.test.ts` (the systemctl calls are integration-only).
  - Unit mirrors the LaunchAgent: `Type=simple` + `ExecStart="<node>" "<cli.js>" daemon start --foreground` so the unit process **is** the daemon, `Restart=on-failure`/`RestartSec=5` (≈KeepAlive), `WantedBy=default.target`. `WorkingDirectory` uses the daemon's own data-dir resolver (`AGENTDECK_DATA_DIR` override, else `~/.agentdeck`) and `installUnit()` `mkdir -p`s that dir first, so systemd never fails at CHDIR on a fresh install. `hasSystemctl()` probes `systemctl --user is-system-running` first — on non-systemd distros or without a user D-Bus session, install degrades to a "run `agentdeck daemon start` manually" hint instead of failing.
  - **`AGENTDECK_DATA_DIR` is captured at install time**: when set, `agentdeck daemon install` persists it into the unit as an escaped `Environment="AGENTDECK_DATA_DIR=…"` directive (a systemd user manager does not inherit the install shell's environment after login/boot — without this the daemon would fall back to `~/.agentdeck` while systemd merely chdirs into the override, splitting state). `WorkingDirectory` and `Environment` derive from the same value; every generated value is escaped per-directive (`%%`, `$$` in ExecStart, `\"`/`\\` in quotes) and validated (absolute path, no control chars/edge whitespace) with actionable install-time errors. Re-run `agentdeck daemon install` to refresh the captured value; when unset, no `Environment=` line is emitted.
  - A user unit only auto-starts on login; for boot-without-login on a headless host the user runs `loginctl enable-linger $USER` once (surfaced as an install-time hint, not run automatically).
  - `daemon.json` discovery, port fallback, singleton guard, and graceful `/shutdown` are reused unchanged across all three platforms.

## Lifecycle는 supervisor를 통과한다 (`stop` / `start` / `restart`)

데몬은 `/shutdown` 을 **자기 자신에 대한 SIGKILL** 로 끝낸다(`exitProcessNow`). 이건 실수가 아니라 유지해야 할 성질이다 — `process.exit()` 가 macOS serial fs worker join 에 걸려 pid 가 남은 실측이 있고(2026-06-06), 9120 을 쥔 채 죽지 않는 데몬은 다시 뜨는 데몬보다 명백히 나쁘다. 문제는 **시그널로 죽은 프로세스는 성공 종료가 아니라는 것**이다: launchd `KeepAlive{SuccessfulExit:false}`, systemd `Restart=on-failure`, Scheduled Task `RestartOnFailure` 셋 다 그걸 크래시로 읽고 몇 초 뒤 되살린다.

2026-09-09 실측(같은 `KeepAlive` 를 단 일회용 LaunchAgent):

| 종료 방식 | launchd | 결과 |
| --- | --- | --- |
| `kill -9 $$` (self-SIGKILL) | 매번 재기동 (~7s 간격, minimum runtime 10s) | `runs` 계속 증가 |
| `exit 0` | 건드리지 않음 | `state = not running`, `last exit code = 0` |

그렇다고 `exit 0` 으로 바꾸는 건 두 번 틀린다. (1) 아무도 복구할 수 없는 실패 모드(안 죽는 데몬)와 맞바꾼다. (2) **두 번째 증상을 고치지도 못한다** — clean exit 이면 launchd 는 의도적으로 재기동하지 않으므로 `daemon restart` 가 fork 한 자식이 매번 포트를 이기고, 데몬은 경합이 아니라 **결정적으로** supervisor 밖에 남는다.

그래서 의도는 종료 코드에 싣지 않는다. 종료 코드는 크래시 여부를 나르는 1비트 채널이고 "사용자가 시켰다" 를 넣을 자리가 없다. 유닛이 설치돼 있으면 `stop`/`start`/`restart` 는 **supervisor 를 통해** 수행한다 (`bridge/src/daemon-supervisor.ts`).

- **macOS 는 비대칭이다.** `launchctl stop` 은 SIGTERM 만 보내고, 데몬의 핸들러는 결국 같은 self-SIGKILL 로 끝나므로 KeepAlive 가 곧바로 되살린다. "멈춘 채로 있어야 하는" stop 은 **`bootout`** 뿐이다(잡 자체를 제거). `bootout` 은 `disable` 이 아니다 — plist 는 그대로 설치돼 있고 다음 로그인에 다시 로드된다. 이건 `systemctl --user stop` / `schtasks /End` 이 이미 뜻하던 것과 같다. 대가는 하나: bootout 이후 `kickstart` 는 `Could not find service` (rc 113) 로 실패하므로 start 는 **`bootstrap` 을 먼저** 해야 한다.
- **`--foreground` 는 라우팅하지 않는다.** 그 철자가 곧 유닛의 `ExecStart` 라서, 라우팅하면 유닛이 자기 자신에게 시작을 요청하게 된다.
- **유닛이 표현할 수 없는 요청은 되가져온다.** 유닛의 argv 는 고정이라 `-p` / `-d` / `--local` / `--loopback` / `--port-window` / `--wake-word` 는 유닛이 만들 수 없는 데몬을 요구한다. 이때는 예전처럼 직접 fork 하고, **그 데몬은 supervisor 밖이라고 말한다** — 아무도 되살리지 않는 데몬이 조용히 생기는 게 바로 이 라우팅이 없애려는 상태다.
- **posture 불일치도 되가져온다.** `restart` 는 돌던 데몬의 posture 를 상속하는데, 그 posture 를 담지 않은 유닛에 재시작을 맡기면 loopback-only 데몬이 광고하는 데몬으로 조용히 바뀐다 — 상속이 막으려던 그 enterprise downgrade다. 그래서 유닛 파일에서 실제 posture 를 읽어(`parseSupervisorPosture`) 비교한다.
- **stop 은 라우팅 여부와 무관하게 유닛도 멈춘다.** 직접 fork 로 재시작하는 경우에도, 유닛이 살아 있으면 옛 데몬을 새 데몬 한가운데로 되살린다.
- 판정은 `routeDaemonLifecycle` 하나에 모여 있다(`supervisor` / `one-off-flags` / `posture-mismatch` / `no-supervisor`). 두 호출부가 같은 질문에 다르게 답하면 안 되고, 호출부에 흩어 쓴 규칙은 한쪽이 잊어도 초록으로 남는다.
- 기다림의 생존 신호도 바뀐다. fork 한 자식이 없으므로 `waitForRestartedDaemon` 의 `isChildAlive` 자리에는 **유닛의 잡이 아직 도는가**(`supervisorLivenessProbe`) 가 들어간다. 없으면 floor(20s)가 그대로 하드 데드라인이 되어, stand-down 협상 중인 정상 기동을 실패로 보고한다 — 이 검증 경로를 다시 쓴 이유였던 그 거짓 실패다.

실측(2026-09-09, 이 머신): 바꾸기 전 상태가 정확히 증상 2였다 — `runs = 7, last exit code = 0, state = not running` 인 유닛 옆에서 ppid 1 짜리 CLI 자식이 9120 을 서빙. `daemon restart` 한 번으로 `state = running, pid = <daemon>` 으로 수렴했고, `daemon stop` 뒤 30초 동안 재기동이 없었으며(이전에는 ~7초), `daemon start` 는 bootout 된 잡을 bootstrap 해서 다시 유닛 아래로 띄웠다.

**아직 열려 있음**: `daemon install` 은 유닛을 로드하기만 하므로, 이미 돌고 있는 (supervisor 밖) 데몬이 있으면 유닛의 잡이 incumbent 가드에 걸려 `exit 0` 하고 그대로 `state = not running` 이 된다. 즉 install 직후에도 데몬은 감시 밖일 수 있다 — 수렴시키는 건 지금은 `daemon restart` 다.

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
- **One machine, one pairing token.** Either daemon can own the port, and they store their credential in different files — the sandboxed app cannot read `~/.agentdeck/auth-token`, and Node must not reach into the app's container (TCC). So the daemon that starts second **adopts the incumbent's token** off the incumbent's loopback `/health` (`adoptPeerToken` in `bridge/src/auth.ts`, `AuthManager.adoptPeerToken` in Swift; the app also re-adopts on each health poll while it is a client). No new trust: the probe dials `127.0.0.1`, and same-machine peers are already fully trusted. Without this, whichever daemon happened to win the port decided whether the paired fleet authenticated, and a handover in either direction closed every board 4001. The superseded token moves to a bounded **accepted ring** (`auth-token-accepted`, max 4, never handed out) so convergence itself cannot lock out a device provisioned a moment earlier.
- **Rotation**: `agentdeck token rotate` retires a leaked token (all paired clients re-pair) and clears the accepted ring — otherwise the retired token would survive in it. `agentdeck token show` prints it for provisioning.
- **Re-arming a device**: the daemon pushes `auth_provision` (credential only, no WiFi side effects) to every serial-attached board whose token differs from the one it serves — independent of WiFi auto-provisioning, and *including* boards whose radio is already up, which `wifi_provision` deliberately skips. A board holding a credential the daemon no longer accepts is online and unreachable at the same time, and USB serial is the only channel that still works when authentication is what is broken. Boards persist the token in NVS (`wifiSaveAuthToken`) and restore it at boot, on every board — not just the two that also persist an endpoint.
- **Pairing a device that has no camera and no cable — `agentdeck pair`** (see below). This is the *only* path by which the token reaches an unauthenticated LAN peer, and it exists because the alternatives cover every device except the ones that need it most: QR needs a camera, `wifi_provision` needs USB serial, and an e-ink reader has neither.
- **Loopback-only posture**: `AGENTDECK_LOOPBACK_ONLY=1` (or `agentdeck daemon start --loopback`) binds `127.0.0.1` **and silences everything the daemon emits** — mDNS advertisement, the 2-second UDP beacon, the Pixoo LAN sweep, and the BLE scans. The USB channels keep working: serial, because a board on a cable is not a network peer, and the ADB reverse tunnel, because it rides the cable into the host's own loopback. It used to pick the bind address only, which left the daemon advertising and scanning for a service nobody on the segment could reach. The startup log names what is off. See [Enterprise / shared-network posture](#enterprise-and-shared-network-posture).
- Tests: `bridge/src/__tests__/http-auth-gate.test.ts`, `pairing-window.test.ts`, `shared/src/__tests__/pairing-code.test.ts`, `mdns-hostname.test.ts` (TXT token absence), `discovery-security.test.ts` (UDP and startup-log absence), `ws-server-auth.test.ts`, Swift `HttpAccessPolicyTests`, `PairingWindowStoreTests`.

### Pairing codes (operator-held window)

```
$ agentdeck pair
  Pairing code:  482 913
  On the device: Settings → Connection → "Pair with code", enter it there.
  The device finds this Mac itself (192.168.68.60:9120) — no cable, no QR scan.
  Valid for 120s, 1 device(s), 5 wrong tries.
  ✓ Paired  CREMA_0680S (android-eink) at 192.168.68.50
```

The device already knows *where* the daemon is (mDNS); what it lacks is the credential. A pairing code is a six-digit secret the operator reads off the host and types on the device, which is the thing a reader's keyboard can actually do — unlike a 32-hex-character `ws://…?token=…` URL, which was the previous advice and is why these readers stayed on `adb reverse`.

| Route | Reachable by | Purpose |
|---|---|---|
| `POST /pair` | unauthenticated LAN peer, **only while a window is open** | redeem `{code, name?, kind?}` → `{token, port}` |
| `POST /pair/open` | same-machine / token-bearing | `{ttlMs?, redemptions?}` → `{code, expiresAt, redemptions}` |
| `GET /pair/status` | same-machine / token-bearing | who paired, who guessed wrong; **never the code** |
| `POST /pair/close` | same-machine / token-bearing | cancel early |

Why it does not widen the boundary:

- **No standing pre-auth route.** With no window open, `POST /pair` is refused by the same default-deny branch as `POST /nonsense`, byte for byte. That equality is deliberate: a distinguishable answer would tell any LAN peer *when somebody is pairing*, which is exactly the moment worth attacking.
- **The operator side is behind the gate.** A remote peer that could `POST /pair/open` would be granting itself a credential.
- **Expiry is enforced on read, never by the timer.** The timer only *reports* the close; `getPairingWindow` re-checks the clock. A timer that fires late — a sleeping laptop, a saturated executor — would otherwise extend the window past its promise.
- **The guess budget is global, not per-IP** (`PAIRING_MAX_FAILED_ATTEMPTS` = 5). An attacker picks their source address, so a per-peer budget is a budget per attempt. Five tries at one-in-a-million, inside two minutes, once, while the operator is watching every attempt scroll past in the CLI.
- **A malformed submission spends nothing** (400, not 401): a typo of the wrong length is not a guess, and burning the operator's window on one would be its own denial of service.
- **`--devices N`** pairs a fleet from one window (the three readers here), capped at 16.

#### Re-arming an ESP32 without a cable — `agentdeck pair --adopt <ip>`

A board cannot type a code, so the code cannot be what authorizes it. What does is the **operator naming its address**, read off the daemon's own refusal line:

```
Rejected 192.168.68.54 (esp32): no pairing token. Attach it over USB serial…
$ agentdeck pair --adopt 192.168.68.54 192.168.68.76
```

During the window, a peer at a named address that tags itself `clientType=esp32` gets `auth_provision` pushed down the socket it just opened — the same message and the same firmware handler as the serial path, which persists to NVS (`Protocol::parseMessage` is shared between `ws_client.cpp` and `serial_client.cpp`). The socket stays unauthenticated throughout: it is never registered as a client, receives that one frame, and is closed `1000` so the board redials with its new credential.

Deliberately **not** "any peer claiming `clientType=esp32` while a window is open" — that claim is unverifiable, and a window opened to pair a phone would then hand the token to anything on the segment that asked. The grant is per-address, one push per board (`noteEsp32Adopted` removes it from the set, so a reconnecting board is not re-provisioned on every dial), and it expires with the window.

A window has **two halves** — the code, for devices with a keyboard, and the adopt list, for boards without one — and closes only when both are spent. Closing on the code alone abandons a board that dials on its own schedule and will always lose a race against a human typing six digits.

**Firmware floor.** The board must apply a token *and re-dial with it*. The token rides the WebSocket URL, fixed at `wsConnect` time, and the WebSockets library auto-reconnects using that same path — which keeps `connected || connecting` true, and `wsConnect` early-returns on exactly that. So `handleAuthProvision` storing the token was not enough: nothing ever asked for a new URL. It now drops the stale socket on a real change and lets `networkTask` rebuild it. Boards flashed before that fix accept the push, save it, and keep dialing the old credential until they **reboot** (boot reads the token from NVS) — so a power-cycle is the cheapest way to bring an older board over.

Rules SSOT is `shared/src/pairing-code.ts`; `pnpm generate-pairing-code-rules` emits the Swift evaluator and the Kotlin client mirror behind a vitest drift gate. The HTTP status per outcome is part of the contract — 401 means "ask the human for the code again", 410/429 mean "the window is gone, stop retrying" — which is why the evaluator is generated rather than hand-ported into the Swift daemon.

### Verifying the boundary by hand

**You cannot test this from the daemon's own machine.** `isLocalConnection()` trusts loopback *and every address on this host's own interfaces*, so `curl http://<my-own-LAN-IP>:9120/health` from the Mac returns the full payload — pairing token included — and that is correct behaviour, not a leak. Reading it as one is a measurement error that has already been made once (2026-08-09, while closing #145).

A real check needs a second host. The cheapest one in this repo is an attached ADB device on the same Wi-Fi:

```bash
adb -s <serial> shell "curl -s http://<daemon-LAN-IP>:9120/health"
# {"status":"ok","mode":"daemon","port":9120,"sameSocketControl":true,"authRequired":true}
```

Expected results from a genuinely remote peer: `GET /health` → 200 with that minimal body; `/status`, `/sessions`, `/timeline`, `/devices` and a wrong `?token=` → 401.

Two traps when reading the results:

- **A WebSocket upgrade answering `101` is not a failure.** Both daemons complete the handshake and then close `4001 Unauthorized` before registering the socket or sending any state. Check for the close code, not the status line.
- **Not every device image has `curl`** — several e-ink Android builds do not. Pick the device before concluding the daemon is unreachable.

The other two discovery transports are checkable locally, since neither is request-scoped:

```bash
dns-sd -Z _agentdeck._tcp local     # TXT must carry project/agent/v/port/ip only
# UDP beacon: bind 0.0.0.0:9121 with SO_REUSEADDR+SO_REUSEPORT alongside the daemon
```

## Enterprise and shared-network posture

AgentDeck is designed for one human at a desk with a fleet of LAN gadgets. On a
corporate segment there are many daemons, usually **no** gadgets, and the LAN
surface is pure attack surface. Two independent switches cover that, and they
deliberately answer different questions:

| Switch | Question it answers | Bind | mDNS / UDP beacon | Pixoo sweep, BLE | USB serial, ADB reverse |
|---|---|---|---|---|---|
| *(default)* | — | `0.0.0.0` | on | on | on |
| `--local` | May this daemon drive hardware? | `0.0.0.0` | off | off | **off** |
| `--loopback` / `AGENTDECK_LOOPBACK_ONLY=1` | May this daemon be seen or heard on the LAN? | `127.0.0.1` | off | off | **on** |

`--local` keeps the all-interfaces bind, so a paired phone or tablet companion
still reaches the daemon with its token; it only stops the daemon driving
devices. `--loopback` is the stricter posture — nothing goes on the wire — but
keeps the USB channels: serial, because a board on a cable is not a network
peer, and ADB reverse for **USB-attached** devices, because over a cable
`adb reverse` terminates on the host's own loopback (the exact interface this
posture binds) and puts nothing on the LAN. Network adb transports —
`adb connect <ip>:5555`, wireless debugging — fail that test and are skipped
under loopback (`isNetworkAdbTransport` in `bridge/src/adb-reverse.ts`). They
compose.

Resolved once at startup by `resolveDaemonPosture()`
(`bridge/src/network-posture.ts`) so the bind address, the module set, and the
startup log cannot disagree. The startup line names what is off.

**Installing the posture.** An enterprise install is an autostart install, so
the flags are baked into the autostart unit's argv — the one channel all three
writers share (Windows Task Scheduler has no environment element):

```bash
agentdeck daemon install --enterprise    # LaunchAgent / systemd unit runs `daemon start --foreground --loopback`; the Scheduled Task runs `daemon autostart --loopback`, which forwards it
npx @agentdeck/setup --enterprise        # install bridge + hooks + that autostart unit, one command
```

`agentdeck daemon restart` reads the running daemon's posture off `/health` and
carries it across the restart, so a restart cannot silently downgrade an
enterprise install back to "advertise everything". Explicit flags still win.

**The macOS app has the same two switches.** A Tier-1 (App Store) user has no
CLI and the sandboxed app cannot be told anything useful through env vars, so
the posture lives in **Settings → Local server**: "Loopback only" and "Disable
device modules" toggles (`AppPreferences.daemonLoopbackOnly` /
`daemonNoDeviceModules`). Changing one restarts the in-process daemon so the
bind address, the Bonjour advertisement, and the module set change together
(`DaemonPosture` in `apple/AgentDeck/Daemon/Core/DaemonPosture.swift` —
module registration is gated deny-by-default, mirroring
`{ ...allModulesOff(), <permitted> }`). The Swift daemon also reports `posture`
on its full `/health`, so `agentdeck qr` / `pair` warn against a loopback-only
app daemon the same way they do against the Node one.

**What you give up, per switch.** `--loopback` originally also stopped the ADB
reverse tunnel — "an admin asking for loopback is asking for quiet" — which
silently killed every USB-tethered Android dashboard for no security gain, since
the USB tunnel carries no LAN traffic. It now survives loopback alongside serial
(USB transports only — network adb devices stay excluded); only `--local` (no
device modules at all) turns it off. `--loopback` makes `agentdeck qr`
and `agentdeck pair` pointless (the peer cannot open a socket to this host at
all); both commands read `posture` off `/health` and say so instead of printing a
dead pairing URL. Neither switch affects the macOS app's own connection — it
dials `127.0.0.1`, not the LAN address.

**Pixoo auto-discovery is off by default.** It used to be on, which meant every
daemon start on a machine with no Pixoo configured POSTed to a third-party cloud
endpoint (`app.divoom-gz.com`) and HTTP-probed all 254 hosts of the local /24 —
undeclared egress plus what an IDS reads as a horizontal scan, from every
developer's machine, on every start. A LAN sweep now happens only where the user
asked for it: `agentdeck pixoo scan` (add `--no-cloud` to keep it on your own
network), **Settings → Pixoo → Scan LAN** in the macOS app, or
`pixooAutoDiscover: true` in `settings.json`. Recovering a *configured* panel
whose DHCP lease moved is deliberately **not** gated on that setting
(`attemptRediscoverIfStuck`): the user already opted into that device, and gating
it turned an IP change into a permanent blackout with no way back in an app that
has no CLI.

**What this does *not* cover.** These switches address the shared-*subnet* case.
The shared-*machine* case — two OS users on one host — has open holes: token
adoption and the operator routes (`/shutdown`, `/stand-down`) trust any local
peer regardless of UID. See [ENTERPRISE-ROADMAP.md](ENTERPRISE-ROADMAP.md) §1.

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

This feature belongs to the legacy managed-session compatibility path and
currently has no daemon-first replacement. It remains functional with no removal
date. Discussion #278 collects affected topologies; #273 requires a validated
outbound worker/relay replacement before the managed implementation can be
removed.

- **Enable**: `--remote-daemon` is THE opt-in switch. `--daemon-host <host[:port]>` only names the explicit endpoint (cross-subnet / SSH where multicast doesn't reach) and **requires the switch** — the recommended explicit form is `--remote-daemon --daemon-host mainnode.lan`. Env equivalents: `AGENTDECK_REMOTE_DAEMON=1`, `AGENTDECK_DAEMON_HOST` (alias `AGENTDECK_REMOTE_DAEMON_HOST`). Default is unchanged (local-only).
- **Opt-in gate (security boundary)**: remote attach never happens on ambient/inherited state — `--remote-daemon` / `AGENTDECK_REMOTE_DAEMON=1` gates **both** remote paths. A host hint given without the switch is inert (the CLI prints a pre-PTY warning via the shared `deriveRemoteAttachOpts` helper, so the derivations can't drift). Within the switch: an unreachable or capability-less named host returns null rather than falling through to mDNS, and mDNS is never consulted on any other signal. With no opt-in and no local daemon, `resolveDaemonTarget` returns null and the session stays local-only (byte-for-byte unchanged). Regression-tested in `bridge/src/__tests__/daemon-target.test.ts` (`resolveDaemonTarget precedence + opt-in gate`).
- **Resolution precedence** (`resolveDaemonTarget`, `session-registry.ts`): local daemon → explicit host → mDNS. A **capable** local daemon always wins — an explicit `--daemon-host` is then not consulted (ordinary local-preferred behavior). Under `--remote-daemon`, an **incapable** local daemon no longer short-circuits resolution: with a `--daemon-host` it falls through to probe the named host (so a tunnel or remote hub is reached instead of dead-ending); without one it warns once and refuses (no mDNS fallthrough — a deliberately-built `ssh -L` tunnel must fail loudly, not silently roam to another LAN daemon). On every reconnect the resolver's result — null included — **replaces** the client's cached target, so a daemon that disappears or is downgraded mid-lifecycle stops being dialed until a valid target resolves again.
- **Capability negotiation**: remote attach requires the main node to run the **Node CLI daemon**, which advertises `sameSocketControl: true` in `/health`. Under `--remote-daemon` **every** accepted target must advertise the flag — including a loopback one, since an `ssh -L` forward of a remote daemon is indistinguishable from a genuine local daemon by IP. The explicit-host path refuses (null + one-shot warning) a daemon lacking the flag; the mDNS confirm step filters such candidates out; `DaemonWsClient` additionally refuses to dial a capability-less target under remote intent (defense against resolver drift). The Swift (macOS app) daemon does not implement the push-channel control frames and is therefore never selected as a remote hub — without the switch, a worker attaching to it locally still just gets a plain (uncontrolled) push registration.
- **Discovery** (`bridge/src/mdns-discover.ts`): the consume side of `mdns.ts` — browses `_agentdeck._tcp`, reads TXT (`port`/`ip`; `token` is only present on pre-#145 daemons), rejects link-local/loopback, confirms each candidate via `/health` (keeps only `sameSocketControl` daemons). Mirrors the iOS/Android `BridgeDiscovery`.
- **Upward auth (session → daemon)**: `DaemonWsClient` connects `ws://<host>:<port>?token=<token>` for remote, `ws://127.0.0.1:<port>` for local. The URL (which can carry the token) is never logged — only host:port plus a token yes/no marker. **Token sourcing (issue #145)**: current daemons no longer serve their token to unauthenticated LAN peers, so the worker must be provisioned — `--daemon-token <token>` or `AGENTDECK_DAEMON_TOKEN` (value in `~/.agentdeck/auth-token` on the hub machine); a legacy daemon's advertised token remains the fallback. Without a token the resolver warns once with that hint and the hub rejects the socket.
- **Remote classification (`remoteAttach`)**: the worker's registration carries an explicit `remoteAttach: true` flag when the user opted in AND the target daemon advertises the capability. The daemon trusts the flag over the socket's source IP — an `ssh -L`-forwarded worker arrives on loopback and is indistinguishable from a local session by IP alone (the non-local-IP heuristic remains as back-compat for older workers). Handled by `bridge/src/session-push-channel.ts` (extracted, integration-tested).
- **Reverse control (daemon → session) — same-socket only**: the worker's outbound push socket is **bidirectional**. When the daemon focuses a remote session it sends command frames back **down the socket the worker already opened** — the daemon never dials back, so a NAT'd / SSH-only worker needs no inbound reachability at all. The daemon stores the live push socket (`remote-sessions.ts` `sender`, `getRemoteSender`); the focus relay drives it (`setSameSocketResolver`) with `session_command_down` frames. On focus it sends `session_focus_down` (worker emits an initial state snapshot up); the worker forwards its `RELAYED_EVENTS` back up as `session_event_up` while focused; unfocus sends `session_unfocus_down`. Commands run through the **same** `applyPluginCommand` handler the local WS server uses (`index.ts`), so local and remote control never diverge. A remote session with no live push socket is unreachable until its worker reconnects.
- **Sender-identity guards**: registration, state updates, event ingestion, and teardown are all keyed to the session's **registered sender socket**. A worker reconnect migrates focus to the new socket (`migrateSender`) before the old close fires; a stale socket's close, state push, or `session_event_up` cannot affect the newer registration; a worker ignores down-frames whose `sessionId` isn't its own. The guard covers the shared push-state **aggregator cache** too, not just the remote registry — in the local + `--remote-daemon` dual-registration case the sessions list dedups to the local row, whose displayed state comes from that cache.

## Observed-session order pins (#273)

Observed sessions (run directly with the daemon installed) have no launch line
to carry `--weight`, so their ordering is daemon-persisted instead: the Node
daemon owns `~/.agentdeck/session-order.json` — a bounded map of weight pins
keyed on the bare session id (`rawSessionId` of the `sessions_list` id, so
`observed:claude:<uuid>` and the bare `<uuid>` address the same pin). The
daemon overlays pins onto observed rows in the sessions enricher, before
fold+sort, so the value rides the existing `SessionInfo.weight` wire field to
every surface — no protocol change, and the Codex display fold (whose key
carries the weight band) never collapses two differently-pinned tabs.

- **Surface**: `GET /sessions/order` lists pins; `POST /sessions/order` with
  `{ sessionId, weight }` sets one and `{ sessionId, clear: true }` (or weight
  `0`/`null`) removes it. Both sit behind the standard LAN auth gate — the
  same-machine CLI needs no token, a remote peer needs the pairing token. A
  mutation triggers an immediate `sessions_list` rebroadcast. `sessionId`
  accepts the exact id, a device-truncated echo, or the bare uuid; a prefix
  must match exactly one live observed session (ambiguity is refused with the
  candidates). CLI: `agentdeck order set|clear|list`.
- **Lifecycle**: pins survive daemon restarts (atomic tmp+rename writes);
  `lastSeenAt` advances whenever the daemon rosters the id, and a pin unseen
  for 30 days is garbage-collected; at most 256 pins persist
  (least-recently-seen evicted first). A `claude --resume <uuid>` session
  re-picks-up its pin because the id is unchanged.
- **Precedence**: observed rows without their own weight only. Managed
  sessions keep their launch-time `--weight`; remote-attached sessions keep
  their pushed weight; the store never overrides an explicit value.
- **Swift parity**: the in-process Swift daemon is a deliberate
  near-transliteration (`apple/AgentDeck/Daemon/Session/SessionOrderStore.swift`)
  — it reads/writes the same `session-order.json` and serves the same
  `GET/POST /sessions/order` with byte-compatible response shapes, so
  `agentdeck order` works against whichever daemon owns the port and pins
  survive a handover in either direction. Unsandboxed dev builds share the
  exact `~/.agentdeck` file with Node; the sandboxed App Store build writes a
  container-local copy Node cannot read (the same asymmetry its
  `daemon.json`/`timeline.json` already carry). The TTL and pin cap are a
  cross-daemon file contract single-sourced in `shared/src/session-utils.ts`
  and emitted to both platforms by `pnpm generate-session-weight-rules`.

## Supporting files

- `bridge/src/mdns.ts` — `bonjour-service` mDNS 광고 (`_agentdeck._tcp`), daemon only
- `bridge/src/mdns-discover.ts` — `bonjour-service` mDNS **browse** (remote-attach discovery), session bridge opt-in only
- `bridge/src/remote-sessions.ts` — daemon-side in-memory registry of cross-machine sessions (live push socket + display host/port), pruned on push-socket close
- `bridge/src/session-push-channel.ts` — extracted push-channel handler (`session_push_register`/`session_push_state`/`session_event_up`) with remote classification + sender-identity guards
- `bridge/src/auth.ts` — `~/.agentdeck/auth-token` 32-char hex 토큰, local bypass, constant-time validation, `rotateToken()`
- `bridge/src/http-auth-gate.ts` — LAN default-deny 정책 (pure functions: `isAuthorizedHttpRequest`/`gateHttpRequest`/`buildPublicHealth`)
- `bridge/src/session-order-store.ts` — daemon-persisted observed-session order pins (`session-order.json`, TTL/size-capped, bare-id keyed) + `/sessions/order` helpers (prefix resolution, weight validation); Swift near-transliteration in `apple/AgentDeck/Daemon/Session/SessionOrderStore.swift`
- `bridge/src/session-registry.ts` — `daemon.json` port discovery (`writeDaemonInfo`/`readDaemonInfo`/`removeDaemonInfo`/`findDaemonPort`/`probeDaemonHealth`)
- `bridge/src/hook-server.ts` — SSE (`/sse`), `/health` (includes `mode` field), `/status`, 토큰 인증
- `bridge/src/ws-server.ts` — remote WS 연결 토큰 검증 (4001 거부), local bypass
