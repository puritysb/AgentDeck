# 2026-03-11 — Timeline 중복 + Generic 라벨 + Daemon 이중 실행

### 문제
Android timeline에 "Prompt sent", "Completed" 같은 generic 라벨 + 중복 엔트리. 근본 원인 3가지:
1. Hook `prompt` 필드 미사용 → 모든 chat_start가 "Prompt sent"
2. Bridge upsert (topic hint 보강 등) → Android에서 새 엔트리로 추가 → 중복
3. Daemon 2개 중복 실행 → 같은 Gateway 이벤트 이중 relay → 중복

### 해결
**(1) Hook prompt 필드 활용** (`bridge/src/index.ts`): `emitChatStart()`에 hook body의 `prompt` 필드 (500자+detail) 전달. `last_assistant_message`로 topic hint 보강

**(2) Upsert 프로토콜** (`shared/src/protocol.ts` → `plugin/src/plugin.ts` → Android):
- `TimelineEventMsg.upsert?: boolean` 플래그 추가
- Plugin: upsert 시 `updateEntryRaw()` (기존 엔트리 교체)
- Android `TimelineStore.kt`: `upsertEntry()` + `updateLastOfType()`
- `StateTimelineGenerator.kt`: prompt-aware chat_start/chat_end, 소급 업데이트

**(3) Daemon singleton guard** (`session-registry.ts` + `daemon-server.ts` + `daemon.ts`):
- `findExistingDaemon()`: session registry에서 `agentType='daemon'` + PID alive 체크
- `startDaemon()` 진입부 + CLI `start` action 양쪽 guard
- `process.exit(0)` — LaunchAgent KeepAlive 재시작 루프 방지

### 교훈 / 핵심 설계 결정
- `findAvailablePort()`가 포트 충돌을 "해결"하는 것이 오히려 문제 — daemon은 반드시 1개만 실행되어야 하므로 singleton guard가 port scanning보다 우선
- Timeline enrichment는 source-rich, client-truncate 원칙 — bridge가 넉넉한 데이터 전달, 각 클라이언트(plugin/android)가 자체 truncation
- Upsert 패턴: 기존 broadcast 인프라에 boolean 플래그 하나 추가로 중복 없는 업데이트 구현

---
