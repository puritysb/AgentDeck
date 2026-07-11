# AgentDeck — App Store vs CLI Feature Matrix

한 장 짜리 레퍼런스. 어떤 기능이 App Store build에서 바로 쓰이고, 어떤 기능이 App Store 밖의 터미널 companion 경로에만 남는지 구분한다.

> **원칙**: App Store build (`bound.serendipity.agent.deck`) 는 Apple Review Guideline 2.5.2 (인터프리터 번들링 금지) 에 맞춰 `Process()` / `/bin/sh` / 번들된 Node·Python·sqlite3 바이너리를 전혀 싣지 않는다. 하드웨어 모니터링/통신은 sandbox entitlement 로 해결되므로 가능. 서브프로세스가 필요한 것만 CLI 로 밀려난다.

## Two-tier product

AgentDeck 은 의도된 2-티어 제품이다. 아래 매트릭스의 모든 행은 이 두 층 중 하나에 속한다.

- **Tier 1 — App Store 앱 단독** (`bound.serendipity.agent.deck`, 샌드박스, PTY 없음): 그 자체로 완결된 모니터링 대시보드. Claude Code hook + Codex lifecycle/notify/OTel 모니터링(앱이 NSOpenPanel 동의로 hook 을 직접 설치), display-only attention(진짜 permission prompt 가 뜬 순간만 — `notification_type: "permission_prompt"` — awaiting + question + macOS 시스템 알림, Allow/Deny 조작 없음), opt-in OpenCode 서버 SSE 모니터링, OpenClaw Gateway, iPad 페어링, D200H/Pixoo/Timebox/iDotMatrix/ESP32 하드웨어, 음성 입력, APME Layer 2, Admin API 사용량.
- **Tier 2 — `agentdeck` CLI 추가 설치** (Node daemon, PTY 소유): 순수한 업그레이드. PTY-managed 세션의 **실제 옵션 스티어링**(`select_option` → PTY 키 주입), Claude 구독 사용량 (5h/7d) + Codex credits relay, 이미 실행 중인 세션의 passive discovery(`ps`/`lsof`/transcript), Android/ADB 기기, ESP32 flash, APME Layer 1.
- **업그레이드 서사는 README / 웹 / 이 문서에만 존재한다.** App Store 앱 안의 어떤 카피도 CLI 설치를 유도하지 않는다 (App Review 4.2.3) — 인앱 카피는 tier 를 모르는 것처럼 동일하게 유지하고, 외부 daemon 감지(`DaemonService.isUsingExternalDaemon`) 시 해당 섹션이 조용히 나타나는 progressive enhancement 만 쓴다.

### Guard conventions (steering UI)

두 티어가 한 UI 를 공유하므로, observed/hook-only 세션에 죽은 버튼이 나타나지 않도록 모든 표면이 같은 규칙을 따른다:

1. **스티어링 컨트롤은 실제 `options[]` 에서만 렌더한다.** 빈 options ⇒ "Respond in the terminal" 폴백 (`MonitorScreen.attentionOptions`, `AttentionTheaterHUD`). Allow/Deny 를 조작(fabricate)하지 않는다.
2. **observed 경로는 `requestId` 를 절대 emit 하지 않는다.** display-only awaiting = `state: awaiting_permission` + `question` 만.
3. `respondToAwaiting`/`select_option` 를 부르는 신규 UI 는 반드시 `stateHolder.state.sessionId == session.id && isAwaiting && !options.isEmpty` 게이트를 지켜야 한다 — 게이트 없이 렌더하면 standalone 에서 no-op 버튼이 된다.
4. attention 판정의 SSOT 는 `isPermissionNotification`(Swift `DaemonServer.swift` / Node `awaiting-overlay.ts` 미러) — `notification_type` 이 권위, free-text regex 는 구버전 fallback. PreToolUse 기반 게이팅은 자동승인 툴에도 발화하므로 금지 (2026-06-27 제거 사유).

## Core dashboard

| Feature | App Store | CLI | 비고 |
|---|:---:|:---:|---|
| macOS Dashboard (`AgentDeck Dashboard.app`) | ✅ | ✅ | 단독 실행 가능 |
| iOS / iPadOS 컴패니언 | ✅ | ✅ | Bonjour + WS, same-LAN |
| Dashboard adaptive orientation + panel parity | ✅* | ✅ | *iOS/iPadOS App Store companion 포함. Android tablet/e-ink viewer 는 아래 Android CLI/ADB tier 분류를 따른다. 회전/패널 의미는 동일하게 유지 |
| Stream Deck+ 플러그인 연동 | ✅* | ✅ | *Elgato Stream Deck 앱 별도 설치 |
| Claude Code hook 설치 | ✅ | ✅ | NSOpenPanel 명시적 동의 |
| 음성 입력 (on-device SFSpeech) | ✅ | ✅ | 오디오 외부 송신 없음 |
| Device Preview catalog | ✅* | ✅ | *App Store 단독 모드는 자체 구동 가능한 preview target **17종** 표시 (Stream Deck ×2, D200H ×2, iPad, InkDeck e-ink, ESP32 LCD ×6 — 86box/3.5"×2/round/TTGO/IPS10, TC001, Pixoo64, Timebox Mini, iDotMatrix, TUI). 외부 daemon 감지 시 Android e-ink / Android tablet 등 ADB-tier preview 3종이 read-only 로 추가 노출 → 20종 (TC001 은 ESP32 serial 보드라 ADB-tier 아님 — 2026-07-10 단독 카탈로그로 편입) |
| APME 평가 Layer 2 (LLM) | ✅ | ✅ | App Store: Apple Intelligence / Anthropic API. CLI: Swift daemon proxy → bundled Swift Foundation Models helper → MLX / OpenClaw. |
| APME 평가 Layer 1 (deterministic) | ❌ | ✅ | `git` / `pnpm` 서브프로세스 필요 |
| Timeline `chat_end` LLM 요약 | ✅ | ✅ | App Store 빌드는 Apple Intelligence (FoundationModels, macOS 26+) → MLX (127.0.0.1:8800) → 휴리스틱 chain. Settings → Timeline summary 에서 backend 픽 가능. 서브프로세스/번들 인터프리터 없음 — `verify-appstore-archive.sh` 통과 |

## Usage / cost 표시

| Feature | App Store | CLI | 비고 |
|---|:---:|:---:|---|
| Claude 구독 사용량 (5h / 7d %) | ⚠️ | ✅ | 외부 daemon 감지 시에만 RATE LIMITS 섹션 표시 (relay). 미감지 시 섹션 자체 숨김 — sandbox 안내 메시지 없이 완결성있게 보임 |
| Codex rate limits (5h / weekly) | ✅* | ✅ | *App Store 단독 지원 — user 승인 security-scoped bookmark 로 `~/.codex` rollout JSONL 을 직접 읽음 (`UsageAPIClient.codexRateLimits`). bookmark 미설정 시 조용히 숨김 |
| Anthropic Admin API 사용량 | ✅ | ✅ | user 가 Console API key 수동 입력 |
| 토큰 / 비용 실시간 (PTY) | ⚠️ | ✅ | App Store 는 hook 기반만, PTY parsing 은 CLI |

## Downstream 하드웨어

| Device | App Store | CLI | 분류 | 비고 |
|---|:---:|:---:|---|---|
| **Ulanzi D200H Deck Dock** | ✅ | ✅ | Built-in USB | **유일 경로: Ulanzi Studio 플러그인**(`plugin-ulanzi`, 공식 SDK, Studio 안에서 WS — AgentDeck.app 에 미번들이라 불변식 무관). direct-HID 폴백은 retire — **Node 삭제(2026-07-08)**, Swift IOKit(`com.apple.security.device.usb`)만 dormant 보존. 토폴로지 행은 양쪽 티어 모두 `ulanzi-plugin` WS presence 로 합성 (Node 기존, Swift 2026-07-11) — 플러그인 미연결 시 행 자체가 사라짐(ghost row 없음) |
| **Divoom Pixoo64** | ✅ | ✅ | Network LED | HTTP, entitlement 불필요 |
| **Divoom Timebox Mini** | ✅ | ✅ | Bluetooth LE | 11×11 RGB. `TimeBox-mini-light` BLE GATT(ISSC transparent-UART `49535343-…`). App Store 단독 Swift 앱: 네이티브 CoreBluetooth (`com.apple.security.device.bluetooth`) — `Timebox{BLE,Module,DivoomPacket}.swift`, micro 레이아웃 11×11 렌더, 서브프로세스 없음. CLI(Node) 데몬: Python `sync_ble.py`(bleak) 자동 spawn. iDotMatrix 와 동일하게 둘 다 뜨면 BLE 단일연결 → 하나만 구동. (구 Bluetooth Classic SPP 변종은 호환성·App Store 제약으로 제거됨) |
| **iDotMatrix LED 디스플레이** | ✅ | ✅ | Bluetooth LE | App Store 단독 Swift 앱: 네이티브 CoreBluetooth (`com.apple.security.device.bluetooth`, hub 모듈). CLI(Node) 데몬: BLE 네이티브 불가 → 데몬이 Python `idotmatrix`(bleak) `sync.py`를 **자동 spawn**(`startIDotMatrixSync`)해 구동 → CLI 데몬만으로 동작. 둘 다 뜨면 CLI 데몬 소유, Swift client-mode stand down(BLE 단일연결) |
| **ESP32 상태 디스플레이 (모니터링)** | ✅ | ✅ | ESP32 Display | `com.apple.security.device.serial`. 보드: `rgb48` / `amoled` / `ips35` |
| **ESP32 Wi-Fi 프로비저닝** | ✅ | ✅ | ESP32 Display | 직접 serial write, subprocess 없음 |
| **ESP32 firmware flash** | ❌ | ✅ | ESP32 Display | `esptool.py` 필요 |
| **InkDeck e-ink** (7.5" 800×480) | ⚠️ | ⚠️ | ESP32 e-ink (WiFi WS, in development) | **개발 중 / not-yet-shipping.** Seeed TRMNL 7.5" OG DIY Kit (XIAO ESP32-S3 Plus + UC8179 800×480 e-ink) 를 **커스텀 AgentDeck ESP32 펌웨어**(PlatformIO env `inkdeck`)로 재플래시 → 다른 ESP32 보드처럼 WiFi WS 로 붙어 데몬이 1-bit 대시보드 프레임을 push. 펌웨어 미완성이라 아직 대시보드 미표시. 전송은 다른 ESP32 와 동일한 WiFi WS(서브프로세스 없음)라 **sandbox 제약 아님** — 펌웨어가 WS 발신 시작하면 App Store ✅ 가능. **구 "TRMNL" 상용 BYOS pull 통합은 제거됨**(Node commit `c71044bd`; App Store Swift `Trmnl*` 모듈 동반 제거) → 순정 TRMNL 패널 미지원 |
| **Ulanzi TC001** (8×32 LED matrix) | ⚠️ | ✅ | ESP32 LED (serial/WiFi) | **ADB 아님.** `led8x32` 펌웨어가 다른 ESP32 보드처럼 USB serial / WiFi WS 로 붙어 state-JSON 을 자기 렌더 (`com.apple.security.device.serial` 커버, tui-dashboard 테스트가 serial board 로 보고). App Store ⚠️ 는 Swift 데몬의 led8x32 경로 미검증인 **구현 갭**이지 sandbox 제약 아님 — HW 검증 후 ✅ 승격 가능. 과거 ADB-classified 경로(`AdbDeviceClass.ulanziTc001` + `TopologyRail.pixelDisplaySection`)는 producer 없는 dead code 였고 **2026-06-25 제거됨** |
| **XTeink X3/X4** (ESP32-C3 e-ink) | ⚠️ | ⚠️ | ESP32 e-ink (WiFi WS, experimental) | **등록 구현됨 / e-ink 렌더 개발 중.** ESP32-C3 e-ink 리더 — AgentDeck `esp32/` 펌웨어가 아니라 오픈소스 **CrossPoint Reader 포크**(`crosspoint-agentdeck`, AgentDeck 스택 branch `master`)의 "Decision Card". 하나의 펌웨어가 런타임 X3/X4 감지 후 `client_register{eink-device}`(→ macOS E-ink rail, 이미 구현) + `device_info{board=xteink_x3/x4}`(→ Node `esp32-wifi`, 추가됨) 이중 등록. 전송은 다른 ESP32 와 동일한 WiFi WS(서브프로세스 없음)라 **sandbox 제약 아님**. 소유 유닛은 pogo USB-data 패드 사망 → SD `update.bin` 플래시만 가능(→ WiFi OTA 대상 아님). 업데이트 펌웨어 플래시 후 대시보드 표시 |
| **Android e-ink** (CremaS / Pantone / Kobo) | ⚠️ | ✅ | Android | **토폴로지 표시는 양쪽 티어** (2026-07-11): 대시보드 앱이 WiFi WS `client_register{clientType:"android-dashboard"}` 자가등록 — XTeink/Stream Deck 과 같은 volunteer-roster 모델, 서브프로세스 없음이라 sandbox 제약 아님. ADB 미러 preview / reverse 터널 등 ADB-tier 기능은 CLI 필요 |
| **Android 태블릿** (Lenovo 등) | ⚠️ | ✅ | Android | 동상 — WiFi `android-dashboard` 자가등록으로 표시는 양쪽 티어, ADB-tier 기능은 CLI 필요 |

## 세션 실행 / agent 런칭

| Feature | App Store | CLI | 비고 |
|---|:---:|:---:|---|
| Claude Code 세션 모니터링 (hook 경유) | ✅ | ✅ | hook HTTP POST 수신 |
| Codex 세션 모니터링 (lifecycle hooks + fallback) | ✅ | ✅ | NSOpenPanel 명시 동의 후 `~/.codex/config.toml` 에 fenced TOML 블록만 편집. 기존 user-owned `[features]` 는 유지하고 AgentDeck이 추가한 `hooks = true` 만 전용 feature fence로 관리. Codex lifecycle hooks → `/hooks/codex_*`, optional notify → `/hooks/codex_turn_complete`, optional OTel → `/otel/v1/traces` |
| 외부에서 이미 실행 중인 Claude/Codex 세션 passive discovery | ❌* | ✅ | `ps`/`lsof`/`/proc` + `~/.claude`/`~/.codex` transcript/rollout JSONL read 가 필요하므로 Node CLI daemon 전용. Node daemon은 Codex Desktop app-server가 현재 열어 둔 top-level rollout만 `codex-app`으로 표시하고 내부 subagent는 제외. App Store 단독 앱은 hook/lifecycle 로 opt-in 된 세션만 표시하며 결함 안내 없이 완결 UI 유지. *예외 2건: **Codex Desktop 앱**은 sandbox-safe `sysctl` 로 passive 감지 (`LocalCodexAppObserver`), OpenCode 서버는 opt-in 시 argv `--port` 검사로 발견 — 터미널 CLI 세션 일반 discovery 만 ❌ |
| Permission prompt 표시 (awaiting + question + 시스템 알림) | ✅ | ✅ | Notification hook 의 `notification_type: "permission_prompt"` (권위 신호 — Claude 가 실제로 permission prompt 를 표시한 순간만 발화; 자동승인 툴은 발화 안 함) 를 `isPermissionNotification` 으로 판별, display-only `awaiting_permission` + `question` 표출 + macOS 시스템 알림(`AttentionNotifier`). 구버전 Claude 는 `looksLikePermissionMessage` regex fallback. `options`/`requestId` 없음 → 모든 표면이 "Respond in the terminal" 렌더 |
| Device approval gating (PreToolUse Allow/Deny) | ❌ | ❌ | **양쪽 모두 2026-06-27 제거.** PreToolUse 는 자동승인 툴에도 발화해 false attention + fabricated Allow/Deny 를 만들었다. 실제 옵션 스티어링은 PTY-managed 세션(CLI)의 OutputParser 가 읽은 real options 로만 |
| OpenCode 세션 모니터링 | ⚠️ | ✅ | App Store: **opt-in** (Settings → Integrations, 기본 OFF ⇒ 프로브 0회). 켜면 사용자가 직접 실행한 OpenCode 서버에 read-only SSE 클라이언트로 연결 — 발견은 사용자 설정 URL / `opencode serve` 기본포트 4096 헬스프로브 / sysctl argv 의 명시적 `--port` 3경로만. **기본 TUI(랜덤 포트, argv 미노출)는 발견 불가** — 포트 스캔 안 함. permission.requested 는 display-only awaiting. CLI: `agentdeck opencode` PTY+SSE 풀 경로 + passive discovery |
| Antigravity 세션 모니터링 | ❌ | ✅ | Antigravity 는 hook/plugin 표면을 제공하지만 App Store 앱이 외부 IDE 세션을 관측하거나 hook 을 설치하지 않는다. CLI daemon 은 standalone Antigravity 프로세스를 passive discovery 해서 creature anchor 로 표시. App Store 앱의 Antigravity 행은 user-approved `state.vscdb` 기반 사용량/크레딧 표시만 |
| Claude / Codex / OpenCode 세션 실행 | ❌ | ✅ | App Store 는 세션 실행 진입점 없음 — `Launch Session` UI 는 2026-05-10 일괄 제거. App Store 빌드는 사용자가 자기 워크스페이스에서 실행한 agent 세션을 hook/lifecycle 로 passive monitor 만 함 |
| OpenClaw Gateway pairing (WS 모드) | ✅ | ✅ | `ws://127.0.0.1:18789` 클라이언트 — RPC error + ws close 1008 reason 기반 auto-fallback (device 서명 거부 시 token-only retry) 포함 |
| OpenClaw shared-token Keychain 저장 (paste) | ✅ | — | Settings → OpenClaw → Advanced 의 SecureField → `OpenClawGatewayTokenStore` (Keychain service `…openclaw.gateway-token`) |
| OpenClaw shared-token import from JSON config | ✅ | — | Settings → OpenClaw troubleshoot row 의 NSOpenPanel — 사용자가 명시 선택한 JSON 파일에서 `auth.token` 한 필드만 추출 → Keychain. `com.apple.security.files.user-selected.read-write` 외 entitlement 추가 없음; `startAccessingSecurityScopedResource()` + `defer stop` 페어링; `directoryURL` 은 `getpwuid(getuid()).pw_dir` 의 real home (Powerbox navigation hint, sandbox app 의 file-system access 아님) |
| OpenClaw Gateway adapter reconnect (Settings) | ✅ | — | Settings → OpenClaw troubleshoot row 에서 `reconnectGatewayAdapter()` 만 호출. daemon/companion 실행, subprocess, 터미널 안내 없음. Claude/Codex sessions 영향 없음 |
| OpenClaw device pairing identity reset | ✅ | — | Keychain `…openclaw.identity` 항목 삭제 (`OpenClawDeviceIdentityStore.deleteIdentity()`) → 다음 connect 에 fresh Ed25519 키쌍 self-gen. daemon 전체 restart 대신 `reconnectGatewayAdapter()` 만 호출 → Claude/Codex sessions 영향 없음 |
| OpenClaw Web UI deep link (Approve in Web UI) | ✅ | — | `NSWorkspace.shared.open(URL("http://localhost:18789"))` — LaunchServices outbound URL, 추가 entitlement 불필요 |
| OpenClaw Gateway pairing (CLI 모드) | ❌ | ✅ | `openclaw` 바이너리 spawn 필요 |

## 인프라

| Component | App Store | CLI |
|---|:---:|:---:|
| Minimum OS (macOS) | macOS 26+ | macOS 15+ Sequoia for the Node bridge; macOS 26+ when using the Swift daemon / Foundation Models helper |
| Minimum OS (iOS/iPadOS) | iOS 17 | — |
| In-process Swift daemon (macOS) | ✅ | — |
| Node.js bridge process | — | ✅ |
| Data directory | `~/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/` | `~/.agentdeck/` |
| Settings (`settings.json`) 읽기 범위 | 자기 컨테이너만 (sandbox) | `getCandidateDataDirs()` 후보 중 mtime 최신본 (`~/.agentdeck` + legacy group container). **App Store sandbox 컨테이너는 후보에서 의도적으로 제외** — 비샌드박스 프로세스가 컨테이너를 직접 읽으면 TCC 가 hang 시킬 수 있음. 따라서 공존 모드에서 daemon 동작 설정 (deviceApprovals, display dim 등) 은 primary daemon 쪽 데이터 디렉토리에서 설정해야 반영된다 |

## 요약

- **App Store 만 써도 (Tier 1)** 가능: Claude Code hook 모니터링 + **display-only attention(permission prompt awaiting + 시스템 알림)**, **Codex lifecycle hooks + notify/OTel fallback 모니터링**, **opt-in OpenCode 서버 SSE 모니터링**, Anthropic Admin API 사용량 조회, iPad 페어링, **D200H / Pixoo / ESP32** 하드웨어, 음성 입력, APME LLM 평가, **timeline LLM 요약 (Apple Intelligence / MLX / heuristic)**.
- **App Store 밖 companion 경로 (Tier 2)**: **PTY 실옵션 스티어링**, **Android 기기 전부** (e-ink + 태블릿), ESP32 firmware flash, **Antigravity 세션 모니터링**, Codex / OpenCode PTY 세션 실행, standalone 세션 passive discovery, OpenClaw CLI 페어링, APME Layer 1 결정적 평가, Claude 구독 사용량 (5h/7d) gauge.

App Store 앱은 companion executable 설치/기동을 요구하지 않는다. 이미 사용자가 터미널에서 별도 daemon을 운영하는 경우에만 같은 포트/WS 프로토콜로 선택적으로 연결되며, 그 신호(`DaemonService.isUsingExternalDaemon`)가 true 일 때만 ADB-tier 디바이스 카드와 RATE LIMITS 섹션이 노출된다(progressive enhancement). 미감지 상태에서는 해당 섹션을 숨겨 단독 앱이 결함 없이 완결성있게 보이도록 한다.

## 유지 원칙 (신규 기능 추가 체크리스트)

이 매트릭스는 단발성 문서가 아니라 **App Store 분리를 지키는 계약**이다. 기능을 추가하거나 이동할 때 아래 순서를 지킨다.

1. **어느 tier 에 속하는지 먼저 결정** — 이 표에 행을 먼저 추가한 뒤 구현을 시작. App Store tier 에 들어간다면 subprocess/bundled interpreter 를 쓰지 않는 구현 경로가 있어야 한다.
2. **subprocess 를 쓰는 코드는 macOS 소스 트리에 들어오지 않는다** — `Process()`, `/bin/sh`, `osascript`, `.command` 스크립트 생성, 외부 CLI (`security`, `sqlite3`, `adb`, `openclaw`, `whisper-cli`) 전부. 비-AppStore macOS GUI 빌드는 더 이상 지원 제품이 아니며, 과거에 있던 `#if !AGENTDECK_APP_STORE` 분기는 2026-04-19 일괄 제거됐다. Swift 컴파일 조건으로 강제되지 않는 TypeScript/plugin 측은 "CLI only" 라는 문서 규칙으로만 분리된다.
3. **App Store 에서 보이는 UI 문구는 companion executable 설치/기동을 유도하지 않는다** — "Install the AgentDeck CLI", "Run `agentdeck daemon install`", "Open Terminal and…" 류 문구는 App Review 4.2.3 리스크. 메시지는 앱 내부 동작 (hook 활성화, Admin API key 붙여넣기) 또는 이미 해결된 상태를 서술한다.
4. **신규 서브프로세스 경로를 반드시 추가해야 한다면** — `apple/scripts/verify-appstore-archive.sh` 의 금지 문자열 목록이 해당 경로를 잡도록 업데이트하고, `apple/APP_REVIEW_NOTES.md` 의 "does not spawn any subprocess" 단락을 함께 수정. CI 가 통과하면 제거됐음이 기계적으로 보장된다.
5. **Signed archive/export + verifier 를 로컬에서 돌린다** —
   ```bash
   bash scripts/build-apple-release.sh --macos
   bash apple/scripts/verify-appstore-archive.sh \
     dist/AgentDeck_macOS.xcarchive/Products/Applications/AgentDeck.app
   ```
   iOS companion 도 같은 tag/release 에 포함되므로 `bash scripts/build-apple-release.sh --ios` 와
   `bash apple/scripts/verify-appstore-archive.sh dist/AgentDeck_iOS.xcarchive/Products/Applications/AgentDeck.app`
   를 함께 통과해야 제출 준비 완료. `CODE_SIGNING_ALLOWED=NO` 빌드는 entitlement 검증 대상이 아니므로
   App Store 제출 근거로 쓰지 않는다.
6. **문서를 같이 갱신** — 이 파일, [apple/APP_REVIEW_NOTES.md](../apple/APP_REVIEW_NOTES.md), [docs/appstore-metadata-draft.md](appstore-metadata-draft.md) 세 곳이 같은 이야기를 해야 한다. metadata 의 "Optional developer extensions" 섹션이 사실과 달라지면 review note 도 함께 수정.

## Anti-patterns (과거 후퇴했다가 복구한 경우)

이 패턴들이 다시 들어오면 App Review 에서 걸릴 가능성이 높다. 코드 리뷰 시 자동으로 주의:

- App Store 코드 경로에서 `Process()` / `NSAppleScript` / `.command` 파일 생성 (2026-04 복구; 2026-04-19 분기 자체 삭제)
- Setup card 문구에서 "Install AgentDeck CLI", "Run `agentdeck daemon install`" (2026-04 복구)
- Settings 에 "Switch D200H to Bundled Helper" 같은 companion binary 기동 버튼 (2026-04 가림; 2026-04-19 코드/UI 모두 제거)
- `openclaw devices approve` 같이 외부 CLI 사용 지시 문구 (2026-04 가림)
- `gatewayAvailable` 만으로 OpenClaw 연결 UI 를 "연결됨" 처럼 그리기 → 반드시 `gatewayConnected` (인증 완료) 기준
- Setup card / RATE LIMITS 섹션에서 "sandbox 안내" 메시지로 "결함" 인상 주기 → 외부 daemon 미감지 시 섹션 자체를 숨겨 단독 앱이 완결성있게 보이도록 한다 (2026-04-19)
