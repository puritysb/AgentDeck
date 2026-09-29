# 2026-07-01 — Daemon 운영 로그 점검 후 TIMELINE/diagnostic hardening

### 문제
라이브 Node daemon 은 `/health`/`/status` 기준 안정적으로 동작했지만, 운영 로그에서 세 가지 개선점이 드러났다. (1) persisted `timeline.json` 에 과거 Codex `tool_exec` firehose 와 OpenClaw `NO_REPLY` polling 찌꺼기가 남아 있고, live WS history 는 필터 후 16개만 내려오지만 late upsert 때문에 timestamp 순서가 어긋날 수 있었다. (2) Claude `<task-notification>` payload 가 서버 저장소에는 `chat_start` 로 남아 클라이언트 렌더 단계 필터에 의존했다. (3) iDotMatrix BLE sync 가 한때 `code=0` clean exit → respawn 을 반복했는데 stdout 이 버려져 종료 원인을 알 수 없었다. 별도로 APME 는 `better-sqlite3` native ABI mismatch(Node 22 daemon vs Codex runtime Node 26)로 비활성화되어 있었다.

### 해결
- shared `timeline.ts` 저장 normalization 에 `isTaskNotificationChatStart` 필터를 추가해 `<task-notification>` `chat_start` 를 서버 저장/브로드캐스트 단계에서 제거.
- `BridgeTimelineStore.getHistory()` / `getHistoryForSession()` 이 항상 timestamp 오름차순 copy 를 반환하도록 변경해 `timeline_history` 와 session detail replay 의 순서를 안정화.
- BLE Python sync helper 가 stdout/stderr 를 live flood 없이 작은 ring buffer 로 캡처하고, iDotMatrix/Timebox daemon sync exit 로그에 clean exit 원인까지 남기도록 변경.
- daemon-managed BLE sync 의 `code=0` 반복 종료는 정상 shutdown 이 아니므로 healthy-uptime backoff reset 대상에서 제외. Timebox `device not found` 나 iDotMatrix clean disconnect 가 5초 루프로 계속 로그를 때리는 경로를 줄였다.
- 로컬 운영 환경에서 daemon Node 22 기준 `better-sqlite3` 를 재빌드해 APME native load 문제를 해소.

### 검증
- `pnpm vitest run shared/src/__tests__/timeline.test.ts bridge/src/__tests__/timeline-integration.test.ts` 성공 — 106 tests.
- `pnpm build` 성공.
- daemon Node v22 및 shell Node v26 양쪽에서 bridge 기준 `better-sqlite3` require 성공.

---
