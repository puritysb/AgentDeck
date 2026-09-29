# 2026-03-20 — Timeline 노이즈 제거: Store-level dedup + 폴백 라벨 개선

### 문제
WhatsApp 헬스체크 cron(5분 간격)이 동일한 chat_start/chat_end 쌍을 생성하여 타임라인 94/100 엔트리가 같은 내용으로 채워짐. `parseLogLine()` 필터는 Gateway `chat` 이벤트(delta→final)를 통과시키므로 무력. LLM 요약 실패 시 "Completed", cron 시작 시 "Prompt sent" 등 무의미한 라벨도 문제.

### 해결
1. **Store-level semantic dedup**: `isRepetitiveEntry()` 공유 함수 — `extractSemanticCore()`로 chat_end의 첫 ` · ` 이전 부분만 비교 (duration/tool suffix 무시). 10분 윈도우 내 동일 core 발견 시 `repeatCount` 증가 + paired chat_start 제거. Bridge/Plugin 양쪽 store에 적용
2. **폴백 라벨 개선**: `'Prompt sent'` → `'자동 작업'` (cron/web), `'Completed'` → `extractTopicHint(response) || 'Completed'` (LLM 미가용 시 응답 첫줄 topic 사용)
3. **텍스트 정제 함수**: `cleanRawText()` (inline **bold**/heading/link/backtick strip), `cleanNopMarkers()` (NOP/NOOP 제거)

### 교훈 / 핵심 설계 결정
- Gateway `chat` 이벤트 기반 timeline은 log-level 필터링으로 제어 불가 — adapter/store 레이어에서 semantic dedup 필요
- `extractSemanticCore()`로 duration/tool suffix를 무시하는 것이 cron 반복 감지의 핵심 (같은 작업이라도 매번 duration이 다름)
- Plugin에도 `extractTopicHint()` 추가 필요 (bridge 없이 Gateway 직접 연결 시 동일 enrichment 보장)

---
