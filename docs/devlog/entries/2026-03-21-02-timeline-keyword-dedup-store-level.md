# 2026-03-21 — Timeline 노이즈 제거: Keyword 유사도 dedup + Store-level 텍스트 정제

### 문제
WhatsApp 헬스체크 cron(5분 간격)이 동일한 chat_start/chat_end 쌍을 생성하여 타임라인 100개 중 94개가 같은 내용. `parseLogLine()` 필터는 Gateway `chat` 이벤트에 무력. LLM 요약이 매번 미묘하게 다른 문장 생성 (`"확인 완료"` vs `"확인 완료, 정상"` vs `"연결 확인 완료"`) → exact string 비교로 dedup 불가.

### 해결
1. **Keyword 유사도 dedup**: `extractKeywords()` — 한국어 어미 정규화 + filler 제거 후 keyword bag 추출. `isSimilarCore()` — 60% overlap threshold. 1시간 윈도우 (5분 cron 대응)
2. **Store-level 텍스트 정제**: `addEntry()` 입구에서 `cleanRawText()`+`cleanNopMarkers()` 일괄 적용
3. **Paired chat_start 안전 제거**: chat_end dedup 시 `isRepetitiveEntry()` 검증 후에만 paired chat_start 제거 (고유 이벤트 보호)
4. **폴백 라벨 개선**: `'Prompt sent'` → `'자동 작업'`, `'Completed'` → `extractTopicHint(response)` 폴백

### 교훈 / 핵심 설계 결정
- LLM 요약이 non-deterministic이므로 exact string dedup은 반복 cron에 무력 — keyword bag 유사도 필요
- 한국어 어미 변형은 suffix strip stemming으로 해결 (`확인하겠습니다`/`확인합니다`/`확인한다` → `확인`)
- Store 입구 텍스트 정제가 adapter별 산재보다 유지보수 우수
- 실시간에서는 `repeatCount` 엔트리의 `ts` 갱신으로 윈도우가 sliding → 배치보다 효과적

---
