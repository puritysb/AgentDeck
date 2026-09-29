# 2026-03-29 — Swift Native Daemon for Mac App Store

### 문제
AgentDeck daemon이 Node.js 의존으로 설치 장벽 높음 (`npm install -g @agentdeck/bridge` + `agentdeck daemon install`). Mac App Store 단일 앱 배포 불가.

### 해결
daemon-server.ts 전체를 **Swift로 재작성** (29 files, ~4800 LOC). macOS 앱(`apple/AgentDeck/Daemon/`)에 in-process 통합.

**핵심 아키텍처**: 별도 daemon 프로세스가 아니라 앱 안에서 직접 실행
- `DaemonService` → `DaemonServer.startServices()` — 앱 시작 시 자동 기동
- WS 서버 (Network.framework) + HTTP 서버 (커스텀 TCP 파서) — 같은 포트 불가하여 port/port+1
- `MenuBarExtra` — Show Dashboard / Launch Session / Start at Login / Quit
- 기존 대시보드(`AgentStateHolder`)는 `ws://127.0.0.1:{port}`로 in-process daemon에 연결

**외부 의존 완전 제거**:
- python3 (CoreGraphics) → `CGDisplayIsAsleep()` 직접 호출
- osascript (볼륨/밝기) → CoreAudio `AudioObjectGetPropertyData` + IOKit `IODisplaySetFloatParameter`
- bonjour-service → Network.framework `NWListener.Service`
- ws/express → Network.framework 네이티브 WS + 커스텀 HTTP

**"설치 한 번이면 끝" 기능들**:
- `HookInstaller` — 앱 시작 시 `~/.claude/settings.local.json`에 hooks 자동 설치
- `SessionLauncher` — 메뉴바에서 Terminal.app으로 `agentdeck claude` 실행
- `DaemonVoiceAssistant` — AVAudioEngine + whisper + AVSpeechSynthesizer
- `PixooRenderer` — 상태→64x64 RGB 픽셀 프레임 변환 (3x5 폰트 내장)

### 핵심 설계 결정
1. **SMAppService.agent()가 아닌 in-process 방식 채택**: agent 바이너리 분리 시 App Review 리스크 + 코드 공유 어려움. 앱 자체가 daemon + dashboard 겸용. Login Item으로 자동 시작
2. **Singleton guard**: Node.js daemon이 이미 실행 중이면 Swift daemon 시작 안 함 → 기존 Node.js 인프라와 공존 가능
3. **HTTP 포트 분리**: Network.framework에서 WS + HTTP 같은 포트 불가 → HTTP는 port+1, 실패 시 port+2~+10 자동 시도
4. **`[String: Any]` Sendable 문제**: Swift 6 strict concurrency에서 dict가 actor 경계를 넘을 수 없음 → `SendableDict` wrapper + `broadcastRaw(Data)` 패턴
5. **GatewayProbe 크래시**: `withCheckedContinuation` + NWConnection `stateUpdateHandler`에서 timer/state 이중 resume → POSIX socket `poll()` 방식으로 교체
6. **MCP는 AgentDeck 제어에 부적합**: MCP 방향이 반대 (Claude→MCP Server). 외부 앱이 Claude Code를 제어하는 유일한 공식 메커니즘은 **Hooks**
7. **80/20 배포 전략**: Mac App(hooks) → 모니터링+권한응답 (80% 사용자), CLI Bridge 추가 → 옵션 선택/모드 전환/diff (20% 파워 유저)

### 파일 (apple/AgentDeck/Daemon/)
- `Server/` — DaemonServer, WebSocketServer, HTTPServer, AuthManager
- `Core/` — StateMachine, DaemonLogger, UsageAPIClient, HookInstaller, SessionLauncher
- `Session/` — SessionRegistry, SessionAggregator, TimelineRelay
- `Modules/` — ESP32Serial, SerialModule, AdbModule (D200H), MdnsModule, PixooModule, PixooRenderer, WifiConfig, ModuleManager
- `System/` — DisplayMonitor, UtilityProxy
- `Gateway/` — OpenClawAdapter (Ed25519 CryptoKit), GatewayProbe
- `Timeline/` — DaemonTimelineStore, TimelineSummarizer, BridgeLogStream
- `Voice/` — DaemonVoiceAssistant
- `DaemonService.swift` — in-process lifecycle + Login Item

---
