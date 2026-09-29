# 2026-06-21 — D200H direct-HID 폴백 폐기: Ulanzi Studio 플러그인 단일 경로로

### 문제
D200H는 Mac용 **Ulanzi Studio** 앱 없이는 제대로 렌더링하기 어려운데, 두 데몬(Node CLI / Swift macOS)이 여전히 **direct-HID 폴백**으로 기기를 직접 잡고 있었다. stand-down은 *Ulanzi 플러그인이 마침 연결돼 있을 때만* 발동(`onUlanziPluginPresence`→`setExternalOwner(true)`)하므로, Ulanzi Studio가 안 떠 있으면 데몬이 기기를 그대로 가로채 "제대로 안 되는 화면"을 그렸다. 어떤 settings 토글도 이를 막지 못했다(중재가 순전히 "플러그인 연결 여부"였음).

### 해결 (activation 비활성화 — 코드는 dormant 보존, 가역적)
- **Node CLI daemon**: `bridge/src/daemon-server.ts`의 `initModules` 설정을 `d200h: 'auto'` → `d200h: false`. `D200hModule.shouldActivate(false)`가 즉시 `false`라 모듈은 `createDefaultModules`로 인스턴스화되지만 `start()` 안 됨 → `node-hid` 미접근. 세션 브리지(`cli.ts`)는 이미 전부 `d200h: false`라 유일한 활성화 지점이었음.
- **Swift macOS daemon**: `apple/AgentDeck/Daemon/Server/DaemonServer.swift`에서 `D200hHidModule()` 생성/등록을 `let enableD200hDirectHID = false` 가드로 감쌈 → IOKit `IOHIDManager` 미생성, `d200hModule`은 `nil` 유지. 모든 소비자가 이미 `if let d200hModule` 가드라 status 스냅샷에서 빠지고 stand-down 훅은 no-op.

### 핵심 설계 결정
- 코드 삭제가 아니라 **activation off** 선택: `D200hModule`/`D200hHidModule.swift`/`bridge/src/d200h/*`/공유 `d200h-layout.ts` 전부 유지. 되돌리려면 Node 설정을 `'auto'`로, Swift `enableD200hDirectHID`를 `true`로 플립.
- `ulanzi-plugin` 등록/stand-down 중재(`ws-server.ts` `onUlanziPluginPresence`, Swift `setExternalOwner`)는 dormant 코드로 그대로 둠 — direct-HID가 살아 있을 때만 의미 있던 경로라 무해.
- `plugin-ulanzi`는 무변경: 이미 기기 소유 + 데몬 죽으면 OFFLINE/press-to-launch(아래 항목).

---
