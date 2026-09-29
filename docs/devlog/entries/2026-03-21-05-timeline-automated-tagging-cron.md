# 2026-03-21 — Timeline automated tagging: cron 채팅 노이즈 근본 해결

### 문제
타임라인 94/100 엔트리가 WhatsApp 연결 상태 확인 cron (30분 간격) 결과로 채워짐. 근본 원인: OpenClaw Gateway `chat` 이벤트가 cron vs user 구분 없이 동일 프로토콜로 방출, `parseLogLine()` 필터는 log stream 전용이라 Gateway 경유 chat 이벤트 우회, semantic dedup(60%, 1h)는 LLM 요약 변형으로 일부 통과.

### 해결
1. **`automated` 태깅**: `TimelineEntry.automated?: boolean` 추가. Bridge adapter + Plugin gateway-client 양쪽에서 `!lastPrompt` (사용자 프롬프트 없이 시작된 채팅 = cron/web/channel) 감지 → `automated: true`. chat_start/chat_end/aborted/LLM upsert 모두 전파
2. **공격적 dedup**: `isRepetitiveEntry()`에서 automated 엔트리끼리는 8시간 윈도우 + content 비교 없이 즉시 중복 판정. 일반 엔트리 1시간 keyword dedup 유지
3. **에러 보존**: `type: 'error'`는 dedup 대상 외 (chat_end/chat_start만) → cron 실패 에러는 항상 표시

### 교훈
- Gateway 프로토콜에 `trigger` 필드가 없어 `lastPrompt` null 여부가 유일한 cron 식별 신호. OpenClaw에 `trigger: 'cron'|'user'|'web'` 필드 추가 요청 필요
- `parseLogLine()` 필터와 Gateway chat 이벤트 경로가 완전히 분리되어 있어, log stream 필터만으로는 Gateway 채팅 노이즈 해결 불가
- 웹 UI 직접 채팅도 `automated: true` 태깅되나, 내용이 매번 다르므로 최초 1회는 항상 표시됨 (실질적 false-positive 없음)

---
