# 2026-04-05 — ESP32 disconnect 복구 견고화 + TC001 상태 UI

### 문제
macOS AgentDeck 앱이 Xcode 디버그 빌드 상태에서 `open -a`로 재실행 시 `T(stopped)` 상태로 부팅 → 포트 9120 listen 되지 않음 → ESP32 보드들이 데몬을 못 찾음. 어제(04-04) 01:33 SIGTERM으로 죽은 뒤 방치된 채 좀비 `dns-sd` 자식 프로세스 4개가 `_agentdeck._tcp` 광고를 계속 유지. 클라이언트가 mDNS로는 daemon을 "발견"하지만 실제 TCP connect는 connection refused. TC001이 `SEARCHING...` 스크롤만 무한 표시. 복구는 수동으로 앱 재기동+SIGCONT 필요.

근본 약점:
- ESP32 firmware가 한 번 `wsConnect(ip,...)` 호출 후엔 그 IP만 영원히 재시도 → daemon IP 바뀌거나 listener 사라지면 리부트 전엔 복구 불가
- `WebSocketsClient`의 `setReconnectInterval()`이 최초 `wsConnect()` 시점에만 호출됨 → 우리 코드가 `reconnectMs`를 backoff로 증가시켜도 라이브러리 내부 타이머는 초기값 고정 (사실상 exponential backoff 미작동)
- 디스플레이가 stale 크리처/세션 스프라이트를 계속 렌더 → 사용자가 disconnect 상태인지 인지 어려움

### 해결
**Firmware 변경** (commit 253eca9):
- `main.cpp`: `bridgeFound` 플래그 제거. mDNS를 always-poll로 전환 → daemon IP 변경(DHCP/호스트 이동) 즉시 감지 후 `wsDisconnect()`+새 IP로 `wsConnect()` 재바인딩. WS backoff가 15초 이상 saturated이면 `mdnsRefresh()`로 캐시 강제 무효화 (좀비 dns-sd 광고 방어)
- `ws_client.cpp`: `setReconnectInterval(reconnectMs)`를 backoff 증가 시마다 재호출 (라이브러리 동기화 버그 수정). `WStype_TEXT` 수신 시 `lastMessageMs` 갱신. `wsLastAttemptMs()`/`wsBackoffMs()` getter 추가
- `serial_client.cpp`: JSON 수신 시 `lastMessageMs` 갱신
- `state/agent_state.h`: `uint32_t lastMessageMs` 필드 추가 (0 = 데이터 한 번도 못 받음)
- `ui/matrix/matrix_pages.cpp`: `SEARCHING...` → 컨텍스트 기반 동적 상태 메시지 (`CONNECT WIFI` / `FINDING BRIDGE` / `DAEMON DOWN 2m` / `NO WIFI 5m` / `OFFLINE`) color-coded by severity. 우상단에 깜빡이는 빨간 점. `renderAgents`에서 disconnect 체크를 세션 수집 이전으로 이동 → stale 크리처 렌더 방지

### 핵심 설계 결정
- **"Don't show stale data" 원칙**: 사용자가 "마지막 데이터 보여주지 말고 상태를 명확하게 표시"라고 명시. Grace period 없이 disconnect 즉시 진단 메시지로 전환. 데이터 age를 함께 표시해 사용자가 "얼마나 오래 끊겼나" 인지 가능
- **mDNS always-poll**: `bridgeFound` flag 패턴은 static configuration에만 맞고 dynamic IP 환경에 취약. 폴링 비용(5s interval)보다 IP drift 복구가 더 중요
- **Saturated backoff = zombie mDNS 신호**: 15초 이상 max backoff(8s) 연속 실패는 "TCP 레벨에서 listener가 없다"는 강력한 신호. 이때 mDNS 캐시 무효화로 좀비 광고 방어. 정상 상황(일시적 네트워크 문제)에선 트리거 안 됨
- **Backoff의 library 동기화**: ESP32용 WebSocketsClient v2.7+는 내부 타이머로 reconnect를 driver → 우리 코드가 `reconnectMs` 변수만 증가시키고 `setReconnectInterval()` 호출을 안 하면 라이브러리는 여전히 초기 interval로 재시도. 이 버그는 기존 모든 ESP32 보드에 영향 (TC001 뿐 아니라 IPS/Round/86 Box도)

### 검증
4대 모두 플래시 + 부팅 확인:
- IPS 3.5" (`usbmodem21133201`) ✓
- Round AMOLED (`usbmodem2111201`) ✓
- 86 Box (`wchusbserial211340`) ✓
- TC001 (`wchusbserial110`) ✓ — `board:ulanzi_tc001`, WiFi `192.168.68.72`, `[Serial] First JSON received` 로그 확인

---
