# 2026-03-12 — Usage 데이터 불일치 수정 (Android/ESP32/Plugin)

### 문제
Android LIMITS, ESP32 TANK STATUS, Claude 실제 사용량이 서로 다르게 표시. Bridge가 단일 소스로 동일 JSON broadcast하지만 3가지 버그로 표시값이 달라짐.

### 해결
**Bug 1 — `buildUsageEvent` DRY 위반**: `index.ts`(5개 파라미터)와 `daemon-server.ts`(4개, ollamaStatus 누락)에 동일 함수 복붙. → `bridge/src/usage-event.ts` 단일 파일로 추출, 양쪽 import. Daemon 8개 call site 모두 `cachedOllamaStatus` 추가.

**Bug 2 — ESP32 sticky values**: Bridge에서 10분 TTL 만료 시 percent 필드 생략 → ESP32 `if (is<float>())` 조건부 파싱이 기존 값 유지 → 오래된 % 계속 표시. → sentinel `-1.0f` 패턴: 필드 부재 시 `-1.0f` 할당, reset 문자열도 빈 문자열로 클리어.

**Bug 3 — ESP32 HUD no-data 표시**: `updateGauge()`에 sentinel 처리 추가 — `pct < 0` → "--" + 빈 게이지. stale 시 "72%!" 표시 (Android과 동일).

### 교훈
- **코드 복제 = drift 불가피**: `buildUsageEvent` 같은 함수를 2곳에 복붙하면 파라미터 추가 시 한쪽이 빠짐. 공용 모듈 추출 필수
- **C/C++ 조건부 파싱의 함정**: `if (field.is<T>()) state = field` 패턴은 필드 부재 시 이전 값 유지 — JSON optional 필드에서는 반드시 else 분기로 sentinel/default 할당
- **sentinel convention**: float에서 0은 유효 값이므로 -1.0f를 "no data" sentinel으로 사용. `reset()` 에서도 0이 아닌 -1.0f로 초기화

---
