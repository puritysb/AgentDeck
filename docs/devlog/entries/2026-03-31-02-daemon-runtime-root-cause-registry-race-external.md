# 2026-03-31 — Daemon Runtime Root Cause 정리: registry race, external-daemon promotion, OpenClaw CLI path

### 문제
- 앱 프로세스는 살아 있는데 daemon registry(`daemon.json`)와 실제 리스너 상태가 어긋나는 경우가 있었다.
- 동시에 실행된 AgentDeck 인스턴스 중 하나가 daemon owner, 다른 하나가 external daemon client일 때 owner가 내려가면 남은 앱이 daemon을 다시 승격하지 못해 전체 기기 연결이 끊길 수 있었다.
- `openclaw-gateway`는 붙어도 `openclaw` CLI binary를 찾지 못해 model catalog / log stream이 비는 상태가 있었다.

### 해결
- `SessionRegistry.swift`: `sessions.json` / `daemon.json` 쓰기를 `replaceItemAt` 기반 원자 교체로 정리해 기존 파일이 있을 때 `moveItem` 실패로 갱신이 누락되는 문제를 줄임
- `DaemonServer.swift`: startup singleton guard에서 health probe가 아직 준비되지 않았더라도 포트가 이미 점유된 경우 곧바로 stale registry로 삭제하지 않고 startup race로 간주
- `DaemonService.swift`: health monitor 추가
  - external daemon이 사라지면 현재 앱이 자동으로 daemon owner로 승격
  - local in-process daemon이 비정상 종료되면 자동 재시작
- `LocalSessionDiscovery.swift`: sandbox container 경로 대신 실제 home(`getpwuid`) 기준으로 `~/.agentdeck/sessions.json` 읽기
- `OpenClawAdapter.swift` / `BridgeLogStream.swift`: `~/Library/pnpm/openclaw`, `~/.local/bin/openclaw`, `~/bin/openclaw`까지 탐색하도록 경로 해상도 확장

### 검증
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataRootCause build CODE_SIGNING_ALLOWED=NO`
- 결과: `BUILD SUCCEEDED`
