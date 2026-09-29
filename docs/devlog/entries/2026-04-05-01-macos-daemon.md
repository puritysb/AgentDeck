# 2026-04-05 — macOS Daemon 포트 바인딩 안정성

### 문제
Mac 화면이 꺼졌다 돌아오면 NWListener가 `Address already in use`로 port 9120 바인딩에 실패. Daemon 프로세스는 살아있지만 WS 서버가 없는 좀비 상태가 되어 모든 클라이언트 연결 불가. 10초 health monitor 감지 후에야 재시작. Node.js CLI daemon에서는 없었던 macOS 앱 전용 버그.

로그 증거:
```
nw_listener_socket_inbox_create_socket bind(409, ::.9120) tcp, ... server failed [48: Address already in use]
Server listener failed: POSIXErrorCode(rawValue: 48): Address already in use
... 10초 후 ...
Local daemon on port 9120 is no longer healthy — restarting in-process daemon
```

### 해결
1. **`NWParameters.allowLocalEndpointReuse = true`** — SO_REUSEADDR 등가. Node.js `http.createServer()` 기본 동작과 일치하여 TIME_WAIT 포트 즉시 재바인딩 가능
2. **Listener `.failed` 상태 콜백 전파** — `WebSocketServer.onListenerFailed` 추가, `DaemonService`에서 수신 후 1s/2s/4s 백오프로 최대 3회 재시도 (10초 health monitor 대기 없이 즉시)
3. **`isPortFree` dual-stack 테스트** — `AF_INET6` + `IPV6_V6ONLY=0` + `::` wildcard로 NWListener가 실제 바인딩하는 주소와 일치 (기존: IPv4 127.0.0.1 전용 테스트)
4. **Network path update IP 변경 시에만 `wakeAll()`** — 화면 꺼짐 중 WiFi flicker로 IP 미변경 path update가 반복되어 module churn 유발. IP 동일 시 timeline relay sync만 실행 (경량)

### 핵심 설계 결정
- **NWListener 기본 바인딩 주소는 `::` (IPv6 wildcard)**. 포트 체크 시 반드시 동일 주소로 테스트해야 정확. IPv4 loopback만 테스트하면 false positive 발생
- **NWListener `.failed` 상태는 반드시 외부로 전파**. 단순 로그만으로는 daemon이 좀비 상태가 됨
- **Network path update는 IP 변경과 분리**. WiFi flicker/VPN 상태 변경은 일상적이고 module 재시작은 비용이 큼. IP 실제 변경일 때만 full wake
- **Node.js `http.createServer()`는 기본 SO_REUSEADDR=true + IPv4 0.0.0.0 wildcard**. Network.framework NWListener는 둘 다 명시 필요
