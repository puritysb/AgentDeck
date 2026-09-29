# 2026-03-21 — Timeline dedup 미동작 근본 원인 + cron 최적화

### 문제
이전 세션에서 `deduplicateEntry()`, `isRepetitiveEntry()` 등 dedup 인프라를 구현했으나, timeline.json에 100개 중 81개가 WhatsApp 반복 — `repeatCount=0`, `automated=false`. Dedup이 전혀 동작하지 않았음.

### 근본 원인
1. **Plugin이 3/20 16:34 구 코드 실행 중** — 빌드(3/21 17:41) 후 재시작 안 됨. timeline.json은 plugin이 쓰는 파일이므로 dedup 코드 미적용
2. **`mergeHistory()` dedup 우회** — bridge 재연결 시 `timeline_history` → `mergeHistory()` → exact `ts:type:raw` 매칭만, `deduplicateEntry()` 미호출
3. **cron CLI 출력이 로그 스트림 유입** — `openclaw cron list/edit` 테이블 행·JSON blob이 `parseLogLine()`에서 error/memory_recall로 오분류

### 해결
1. `mergeHistory()`에 `deduplicateEntry()` 적용
2. `parseLogLine()` — cron 테이블 행 감지, error 상태만 `"Cron error: {name}"` 한 줄 요약 (ok/skipped 스킵). JSON blob·fragment 필터
3. WhatsApp 헬스체크 cron `*/5` → `*/30` (30분, heartbeat과 일치)
4. Plugin + Daemon 재시작, timeline.json 초기화

### 교훈 / 핵심 설계 결정
- **코드 변경 후 프로세스 재시작 확인 필수** — `ps -p PID -o lstart=`으로 빌드 시간 vs 프로세스 시작 시간 비교
- `mergeHistory()`처럼 bypass 경로가 있으면 dedup이 무력화됨 — 모든 입구에 dedup 파이프라인 적용
- cron list 출력 같은 "도구 출력"이 로그 스트림으로 유입되는 건 예측 어려움 — 패턴 기반 필터보다 구조적 필터(subsystem/module) 우선, 나머지는 UUID·JSON 패턴으로 보충
- 5분 LLM 헬스체크는 근본적으로 낭비 — cron 주기를 heartbeat(30분)에 맞추는 게 적절

---
