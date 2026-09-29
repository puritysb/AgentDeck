# 2026-03-09 — Daemon Usage Relay (429 rate limit 해소)

### 문제
Daemon + Bridge가 동시에 Anthropic OAuth Usage API를 호출하면서 429 rate limit 악순환. Android에서 rate limit 게이지 표시 불가.

### 해결
- Bridge `hook-server.ts`에 `GET /usage` 엔드포인트 추가 (no auth, local only) — `{ status, usage, fetchedAt }` 반환
- Bridge `index.ts`에서 `hookServer.onApiUsage(...)` 연결
- Daemon `daemon-server.ts`에 3-tier relay 구현:
  1. **HTTP**: sibling bridge `GET /usage` (2s timeout, 5분 freshness)
  2. **WS**: sibling bridge WS 연결 → `usage_update` 이벤트 수신 (3s timeout) — 이전 코드 bridge에서도 동작
  3. **Direct API**: sibling이 없을 때만 (단독 caller = 429 없음)
  - Sibling 있으면 직접 API 호출 안 함 → 429 방지
- mDNS "Service name already in use" 비동기 에러 → daemon 크래시 방지 (`uncaughtException` 핸들러에서 무시)

### 교훈 / 핵심 설계 결정
- **WS relay가 HTTP보다 범용적**: bridge가 이전 코드여도 WS `usage_update`는 항상 broadcast됨. HTTP `/usage`는 새 코드 필요
- **Sibling 있으면 직접 API 절대 안 치기**: bridge+daemon 동시 호출 = 429 확정. Sibling이 있으면 relay 실패해도 API 직접 호출 금지
- **mDNS는 non-critical**: `bonjour-service` publish 에러가 비동기 throw → uncaughtException → 프로세스 종료. mDNS 실패는 무시해야 함
- **Daemon 재시작 시 adb reverse 미설정**: Crema(WiFi 없음)는 수동 USB 연결 필요
- **Android `last_bridge_url` DataStore**: mDNS LAN IP 저장 → USB-only 디바이스 연결 실패 루프

### E-ink Status 리디자인
- Canvas 게이지바 → Unicode 블록 게이지(`█░`) — 순수 텍스트, e-ink 최적
- 1컬럼 스택 → 2컬럼 분할: LIMITS(30%) | MODELS(70%), 세로 구분선
- `Arrangement.Center` 수직 가운데 정렬, 섹션 헤더 11sp + 3dp bottom padding
- PROCESSING시 context 없으면(OpenClaw) split 안 함 → Status full-width

---
