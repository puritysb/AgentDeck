# 2026-03-11 — Timeline "Completed" 고착 버그 수정

### 문제
AgentDeck 타임라인에서 `chat_end` 항목이 항상 "Completed"로만 표시됨. 한국어 LLM 요약이 동작하지 않음.

### 원인
1. MLX 서버 크래시 (CloudStorage 데드락 → `reload=True` 문제, 별도 수정 완료) 시 `timeline-summarizer.ts`에서 `mlxAvailable = false`가 영구 설정됨
2. Ollama도 실패하면 `ollamaAvailable = false` → 두 LLM 모두 영구 스킵 → `summarizeResponse()` 항상 `null` 반환
3. Plugin에는 bridge와 달리 요약기 자체가 없어, bridge 없이 단독 운영 시 요약 불가

### 해결
1. **Bridge `timeline-summarizer.ts`**: availability flag에 60초 TTL 추가 — 실패 후 60초 경과 시 재시도
2. **Plugin `timeline-summarizer.ts`** (신규): plugin용 경량 MLX 요약기 추가
3. **Plugin `gateway-client.ts`**: `chat_end` 후 비동기 LLM 요약 → `upsertEntry()`로 "Completed" 교체
4. **Plugin `timeline-store.ts`**: `upsertEntry()` 메서드 추가 (ts+type ±1s 매칭)

### 교훈
- Boolean availability flag는 영구 disable 위험 — 반드시 TTL/retry 메커니즘 필요
- Bridge와 plugin 양쪽에 동일 기능 필요 시, bridge 단독 의존은 SPOF — plugin도 독립 동작 가능해야 함

---
