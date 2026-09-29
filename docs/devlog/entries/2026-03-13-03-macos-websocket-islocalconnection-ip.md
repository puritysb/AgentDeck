# 2026-03-13 — macOS 앱 WebSocket 연결 실패 (isLocalConnection 자기 IP 미인식)

### 문제
macOS Apple 앱이 같은 머신의 bridge/daemon에 연결 실패. URLSession이 "Socket is not connected" (errno 57) 보고. 실제 원인은 WS 서버의 4001 close (Unauthorized).

머신에 두 IP (`192.168.0.102`, `192.168.0.107`)가 있고, `isLocalConnection()`이 `127.0.0.1`/`::1`만 localhost로 인식. 앱이 LAN IP로 토큰 없이 연결하면 "remote" 취급 → 4001 거부.

### 해결
1. `bridge/src/auth.ts` — `isLocalConnection()`에 `os.networkInterfaces()` 순회 추가. 머신 자체 IP (IPv4 + `::ffff:` 매핑) 모두 local로 인식
2. `Info.plist` — `NSAppTransportSecurity` / `NSAllowsLocalNetworking` 추가 (ws:// 연결 ATS 예외)
3. 이전 세션에서 추가한 `onReconnectAttempt` 콜백 + `LocalSessionDiscovery.readSessionsNow()` — reconnect 실패 시 sessions.json에서 로컬 브리지 자동 발견

### 교훈 / 핵심 설계 결정
- **URLSession 4001 → errno 57**: WebSocket 서버가 upgrade 단계에서 4001로 닫으면 URLSession은 "Socket is not connected"로 보고. 실제 원인 파악 어려움 — WS 서버 로그를 먼저 확인할 것
- **듀얼 NIC 환경**: macOS에서 유선+무선 동시 사용 시 IP가 여러 개. localhost 판별은 반드시 `networkInterfaces()` 순회 필요
- **sessions.json 기반 로컬 디스커버리**: macOS 앱은 같은 머신이므로 mDNS 대신 `~/.agentdeck/sessions.json` 직접 읽기가 더 확실 (Phase 1에서 구현)

---
