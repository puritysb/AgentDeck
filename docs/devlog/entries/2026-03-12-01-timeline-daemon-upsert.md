# 2026-03-12 — Timeline 중복 표시 버그 (daemon upsert 누락)

### 문제
Android TimelineStrip에서 `chat_start` 이벤트가 동일 timestamp로 중복 표시. "Prompt sent" + "MoltBook 야간 스웜 작업 시작"처럼 원본+enriched 버전이 둘 다 나타남.

### 해결
**근본 원인**: `daemon-server.ts`가 adapter의 `evt.upsert` 플래그를 무시하고 항상 `addEntry()` 호출. `extractTopicHint()`가 chat_start를 enrichment할 때 upsert로 보내지만, daemon이 새 항목으로 추가 → raw가 다르므로 5s dedup도 통과 → WS broadcast에도 upsert 플래그 누락 → Android가 2개 항목 저장.

3곳 수정:
1. **daemon-server.ts timeline case**: `evt.upsert` 분기 추가 → `upsertEntry()`/`addEntry()` 분리
2. **daemon-server.ts onEntry 리스너**: `(entry, upsert)` 시그니처 + broadcast에 `upsert: true` 포함
3. **Android TimelineStore.addEntry()**: 5s 윈도우 type+summary dedup 안전장치 추가

### 교훈
- **코드 복제 시 분기 누락 위험**: `index.ts`(coding bridge)에는 upsert 분기가 있었으나 `daemon-server.ts`에는 누락. 동일 이벤트를 처리하는 두 경로가 있으면 반드시 양쪽 동기화 확인
- **dedup은 다층 방어**: source(upsert) + store(5s dedup) + client(dedup) — 어느 한 층이 실패해도 다른 층에서 잡아야

---
