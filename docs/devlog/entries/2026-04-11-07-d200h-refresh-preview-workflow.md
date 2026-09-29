# 2026-04-11 — D200H 런타임 Refresh + Preview Workflow

### 문제
macOS 앱을 다시 빌드해도 D200H 화면이 바뀌지 않는 것처럼 보였다. 실제 확인 결과 D200H ZIP dump는 Swift 경로에서 계속 생성되고 있었지만, 실행 중인 AgentDeck 번들이 빌드한 산출물과 달라질 수 있었다. 특히 Codex 샌드박스 안에서 `open /tmp/.../AgentDeck.app`를 실행하면 LaunchServices가 번들을 못 보고 `kLSNoExecutableErr`를 반환했지만, 승인된 GUI 실행에서는 정상적으로 열렸다.

### 해결
- `DaemonServer.swift`
  - `POST /d200h/refresh` endpoint 추가. D200H 모듈의 상태 hash를 비우고 다음 `updateDisplay()`가 full `set_buttons`를 다시 보내도록 함.
- `D200hHidModule.swift`
  - `forceFullRefresh(reason:)` 추가.
  - 세션 캐시가 아직 비어 있고 직전 full slot도 없으면 blank `set_buttons`를 보내지 않고 `refreshSkipped: "no_cached_sessions"`로 반환하도록 guard 추가.
- `scripts/d200h-preview-dump.mjs`
  - 최신 `*-set_buttons-*.zip` 또는 지정 ZIP을 추출해 `d200h-contact-sheet.png`, `preview.html`, `manifest.json`을 생성.
- `.agents/workflows/d200h-preview.md`, `package.json`
  - 반복 진단 명령을 `pnpm d200h:preview -- --out /tmp/agentdeck-d200h-preview`로 고정.

### 검증
- 새 guard 빌드:
  - `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataD200HRefreshGuard build CODE_SIGNING_ALLOWED=NO`
  - 결과: `BUILD SUCCEEDED`
- 실행 중인 runtime 확인:
  - `/health` 응답 pid: `44757`
  - 실제 실행 번들: `/Users/puritysb/Library/Developer/Xcode/DerivedData/AgentDeck-dqyrhbwpqboxgiabhllzxkkjxqzy/Build/Products/Debug/AgentDeck.app`
  - `d200h.connected=true`, `sessionsCount=4`, `writeFail=0`
- 강제 refresh:
  - `curl -sv -X POST http://127.0.0.1:9120/d200h/refresh`
  - 결과: `200 OK`, `status=ok`, `sessionsCount=4`, `writeFail=0`
- ZIP preview:
  - `pnpm d200h:preview -- --out /tmp/agentdeck-d200h-preview-final`
  - 대상 dump: `~/.agentdeck/d200h-dumps/20260411-083358-107-set_buttons-L-62661b-GATEWAY_OPENCLAW_AGENTDECK_AGENTDECK.zip`
  - `btn0.png`, `btn1.png`, `btn2.png`, `btn13L.png` 모두 196×196 PNG.
  - contact sheet에서 세션 아이콘/상태 점/텍스트가 top-down 좌표로 정상 배치됨.

### 핵심 판단
- D200H가 안 바뀌는 것처럼 보일 때 먼저 봐야 하는 순서:
  1. `ps`/`/health`의 pid와 app bundle path가 방금 빌드한 산출물인지 확인.
  2. `POST /d200h/refresh`로 full `set_buttons`를 강제 전송.
  3. `pnpm d200h:preview`로 최신 ZIP의 실제 PNG 좌표를 확인.
  4. ZIP preview는 정상인데 실기기만 다르면 그때부터 firmware apply/cache 문제로 보고 Ulanzi SDK/Studio capture를 protocol oracle로만 사용.
- Ulanzi SDK는 AGPL-3.0이고 UlanziStudio host runtime에 묶이므로 AgentDeck 런타임 종속성으로 채택하지 않는다. 현 단계의 근본 해결책은 stock HID ZIP 경로 유지 + dump/preview/force refresh 관측성 강화다.

---
