# 2026-04-29 — Codex observation startup port-read 제거

### 문제

로컬 배포 검증 중 macOS 앱이 `DaemonServer.startServices()` 의 Codex observation 설치 단계에서 main actor 를 오래 점유했다. 샘플링 결과 `CodexConfigInstaller.installIfNeeded()` 가 OTel endpoint 를 만들기 위해 방금 시작 중인 daemon 의 `daemon.json` 을 동기 읽는 경로에 머물렀고, 그 사이 HTTP/WS/D200H refresh 요청이 포트 연결 후 응답을 받지 못했다.

### 해결

- `CodexConfigInstaller.installIfNeeded(daemonHttpPort:)` 를 추가해 `DaemonServer` 가 이미 알고 있는 bound port 를 직접 전달한다.
- startup 경로에서는 `daemon.json` 재읽기를 피하고, Settings 등 수동 재설치 경로만 기존 fallback read 를 유지한다.

### 검증

- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' CODE_SIGNING_ALLOWED=NO` 성공

---
