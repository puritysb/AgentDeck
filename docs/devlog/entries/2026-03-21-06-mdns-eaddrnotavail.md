# 2026-03-21 — mDNS EADDRNOTAVAIL 크래시 → 복구 로직

### 문제
macOS 슬립/WiFi 재연결 시 `bonjour-service`가 mDNS multicast (`224.0.0.251:5353`)로 `send()` 호출 → `EADDRNOTAVAIL` 에러를 비동기 throw → `uncaughtException` 핸들러가 `"already in use"` 문자열만 체크 → 미매칭 → `shutdown()` 호출 → shutdown 중 동일 에러 재발 → 프로세스 종료. Daemon과 session bridge 양쪽에서 동시 발생. LaunchAgent `last exit code = 0` + `successful exit` semaphore로 재시작 루프 안 돎.

### 해결
1. `bridge-core.ts` `uncaughtException`: `EADDRNOTAVAIL` + `5353` 패턴도 무시 → 프로세스 생존
2. `invalidateMdnsInstance()`: 에러 발생 시 Bonjour 인스턴스 destroy + null 마킹
3. `mdns.ts` 복구 타이머 (30s): `instance === null` + `getLanIp() !== undefined` 감지 시 자동 re-publish

### 교훈
- `bonjour-service`는 자체 복구/재연결 없음. 소켓 에러 시 `errorCallback`으로 throw만 함
- 에러 무시만으로는 불충분 — mDNS 광고가 죽은 상태로 남아 원격 클라이언트 발견 불가
- 네트워크 상태 변화에 대한 방어는 "무시 + 복구" 쌍으로 구현해야 함

---
