# 2026-03-11 — OpenClaw Timeline 중복 & 노이즈 이벤트 수정

### 문제
1. **이벤트 중복**: Bridge 연결 중에도 plugin `logStream`이 독립 실행 → 같은 `openclaw logs` 출력을 bridge(relay)와 plugin(직접 파싱) 양쪽에서 추가하여 동일 이벤트 2회 표시
2. **에러 노이즈**: `web_fetch timed out` 같은 일시적 네트워크 에러가 타임라인에 노출 (에이전트가 내부 재시도하는 에러)
3. **"Prompt sent" 고착**: 외부 트리거 채팅(cron, 웹 UI)에서 토픽 추출 윈도우가 20~200자로 너무 좁아, 첫 delta가 200자 넘으면 추출 기회 0

### 해결
1. **logStream 자동 관리**: `receivingBridgeTimeline` setter에서 `logStream.stop()/start()` 호출 — bridge 연결 시 중복 소스 제거
2. **timeline-store dedup 안전망**: plugin/bridge 양쪽 `addEntry()`에 5초 윈도우 type+raw 중복 검사
3. **transient error 필터**: `shared/timeline.ts` `parseLogLine()`에서 web_fetch+timeout/ECONNREFUSED 패턴 필터
4. **토픽 추출 개선**: `topicExtracted` 플래그 도입 + 200자 상한 제거. 한 번 추출 후 반복 덮어쓰기 방지, 큰 첫 delta에서도 추출 가능

### 교훈
- 다중 소스 파이프라인에서는 **소스 제거가 dedup보다 우선** — dedup은 안전망일 뿐
- 토픽 추출 같은 one-shot 로직에는 반드시 완료 플래그 필요 (윈도우 상한보다 명시적)

---
