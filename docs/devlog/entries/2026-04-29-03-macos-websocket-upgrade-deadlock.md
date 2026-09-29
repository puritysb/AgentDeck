# 2026-04-29 — macOS WebSocket upgrade deadlock 수정

### 문제

macOS in-process daemon 이 `9120` 에서 정상 기동한 뒤에도 Dashboard `BridgeConnection` 이 `ws://127.0.0.1:9120` 로 연결되지 않고 약 60초 뒤 `Ping failed` / `Receive error: The request timed out` 를 반복했다. 서버 로그는 클라이언트 타임아웃 직후에야 `WS: Client connected` 를 찍고 곧바로 `Connection reset by peer` 로 닫혔다.

원인은 `WebSocketServer.handleNewConnection` 이 첫 TCP 청크를 읽은 뒤 `HTTPServer.receiveFullRequest(accumulated:)` 에 넘겼지만, `receiveFullRequest` 가 이미 누적된 완전한 WebSocket upgrade 헤더를 먼저 판정하지 않고 추가 `receive` 를 먼저 기다린 점이었다. WebSocket 클라이언트는 `101 Switching Protocols` 응답 전에는 추가 바이트를 보내지 않으므로 서버/클라이언트가 서로 기다리는 deadlock 이 발생했다.

### 해결

- `HTTPServer.receiveFullRequest` 가 누적 버퍼를 먼저 검사하고, headers/body 가 이미 완전하면 즉시 completion 을 호출하도록 변경했다.
- 누적 버퍼가 불완전할 때만 추가 `NWConnection.receive` 를 걸도록 request completion 판정을 helper 로 분리했다.
- Codex OTel 대용량 POST 를 위해 추가했던 full-body read 경로는 유지하면서, body 없는 WebSocket upgrade 요청은 즉시 handshake 로 넘어가게 했다.

### 검증

- `git diff --check` 성공
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataWsHandshake CODE_SIGNING_ALLOWED=NO` 성공

---
