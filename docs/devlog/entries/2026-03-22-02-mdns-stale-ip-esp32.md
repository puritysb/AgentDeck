# 2026-03-22 — 디바이스 연결 실패 진단 (mDNS stale IP, ESP32 포트 식별)

### 문제
1. iPad/iPhone이 daemon에 연결 안 됨 (ConnectionOverlay 표시)
2. ESP32 Round AMOLED이 "No WiFi" 표시 (시리얼 데이터는 수신 중)
3. Daemon이 간헐적으로 크래시 (stderr 로그 없이 죽음)

### 해결
1. **mDNS stale IP**: daemon 시작 시 `getLanIp()`가 반환한 IP가 DHCP 갱신으로 변경되었지만 mDNS TXT 레코드가 갱신되지 않음. `mdns.ts` recovery timer에 IP 변경 감지 추가. Apple 앱에서 TXT `ip` 필드를 무시하고 항상 `NWConnection` endpoint resolution 사용. iOS waterfall을 macOS와 동일하게 mDNS-first로 변경 (stale `savedUrl` 5초 대기 제거)
2. **Session mDNS 광고 버그**: `cli.ts`에서 session bridge가 `mdns: true`로 mDNS 광고하고 있었음. `mdns: false`로 수정
3. **ESP32 "No WiFi"**: 펌웨어가 connection overlay에서 `serialConnected()` 상태를 무시하고 WiFi 없으면 무조건 "No WiFi" 표시. 시리얼 연결도 유효한 연결로 간주하도록 `main.cpp` 수정
4. **Daemon 크래시 추적**: `uncaughtException`에서 `process.exit(0)`하기 전 `~/.agentdeck/daemon-crash.log`에 스택 트레이스 append
5. **ESP32 포트 혼동**: `usbmodem` 번호가 USB 허브 포트/케이블에 따라 변동됨. `device_info_request` JSON으로 보드 식별하는 방식으로 전환

### 교훈 / 핵심 설계 결정
- **ESP32 USB 포트 번호는 고정이 아님** — 같은 보드도 다른 허브 포트/케이블에 꽂으면 번호 변경. 플래시 전 반드시 `device_info_request`로 보드 확인 필수
- **mDNS TXT record의 `ip` 필드는 신뢰할 수 없음** — Bonjour 캐시 + DHCP 갱신으로 stale 가능. endpoint resolution이 유일한 확실한 방법
- **`uncaughtException` → `process.exit(0)`은 LaunchAgent `SuccessfulExit: false`와 조합 시 재시작 안 됨** — crash log 별도 보존 필수
- **시리얼 연결은 WiFi와 동등한 "연결" 상태** — ESP32 펌웨어에서 connection overlay 로직이 WiFi만 체크하면 시리얼 전용 환경에서 영구 "No WiFi" 표시

---
