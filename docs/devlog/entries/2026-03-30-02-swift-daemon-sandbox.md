# 2026-03-30 — Swift Daemon: 통합 서버 + Sandbox 경로 수정

### 문제
macOS AgentDeck.app의 in-process Swift daemon이 CLI(`agentdeck daemon status`)에서 발견되지 않고, 외부 디바이스도 연결 불가.

### 해결
3개 버그 동시 수정:
1. **App Sandbox 경로**: `FileManager.default.homeDirectoryForCurrentUser`가 컨테이너 경로 반환 → `getpwuid(getuid()).pw_dir`로 실제 `~/.agentdeck/` 접근 + `temporary-exception.files.home-relative-path.read-write` entitlement 추가
2. **HTTP/WS 포트 분리**: NWProtocolWebSocket이 모든 연결을 WS로 강제해서 HTTP 불가 → raw TCP NWListener 하나로 통합. 연결별 HTTP/WS 자동 감지, WebSocket 프레임 수동 파싱, Bonjour 서비스를 동일 리스너에 부착
3. **WebSocket GUID 오타**: `258EAFA5-E914-47DA-95CA-5AB9E73FE56E` → 정확한 RFC 6455 GUID `258EAFA5-E914-47DA-95CA-C5AB0DC85B11`

### 핵심 설계 결정
- **NWProtocolWebSocket 사용 중지**: NWListener 레벨에서 WS 프로토콜을 설정하면 해당 포트의 모든 연결이 WS로 강제됨 → HTTP 겸용 불가. raw TCP + 수동 프레임 파싱으로 Node.js의 `http.createServer()` + `ws` 패턴과 동일한 단일 포트 동작 달성
- **mDNS 리스너 통합**: 별도 NWListener로 Bonjour 광고 시 이미 점유된 포트에 bind 실패 → 통합 서버의 NWListener에 `NWListener.Service` 직접 부착으로 해결
- **WebSocket GUID**: RFC 6455 정확한 값은 `258EAFA5-E914-47DA-95CA-C5AB0DC85B11`. 인터넷에 잘못된 GUID가 돌아다니므로 반드시 `ws` 라이브러리 constants.js 참조 확인

---
