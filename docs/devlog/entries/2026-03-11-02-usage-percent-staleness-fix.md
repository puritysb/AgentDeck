# 2026-03-11 — Usage Percent Staleness Fix

### 문제
Android rate limit 게이지가 실제와 크게 다름 (7% 표시, 실제 33%). 실측: bridge 캐시가 3.4시간~15.5시간 전 데이터를 무기한 broadcast. API 429 실패 → `apiUsageStale=true` 마킹하지만 `cachedApiUsage` 값은 유지 → 시간이 갈수록 캐시 낙후. Daemon은 `usageStale` 필드 자체가 누락.

### 해결
**(1) Bridge 10분 TTL** (`bridge/src/index.ts`): 5초 broadcast tick에서 `lastApiFetchTime`이 10분 초과 시 `cachedApiUsage = null` 클리어. Android가 null 수신 → 게이지 숨김.

**(2) Daemon fetchedAt 보존** (`bridge/src/daemon-server.ts`): `fetchUsageViaHttp` → `RelayedUsage { usage, fetchedAt }` 반환. Daemon의 `lastApiFetchTime`을 sibling의 원래 fetch 시각으로 설정 (자기 relay 시각이 아님). 동일 10분 TTL 적용.

**(3) Daemon `usageStale` 필드 추가**: `buildUsageEvent`에 `stale?` 파라미터 추가, `apiUsageStale` 상태 변수 도입. Relay 실패 시 `apiUsageStale = true`, 성공 시 `false`.

### 교훈 / 핵심 설계 결정
- Stale 캐시 표시(! suffix)만으로는 불충분 — 값 자체가 오래되면 **클리어**해야 클라이언트가 올바르게 반응 (숨김 vs 오래된 값 표시)
- Relay 체인에서 fetchedAt 보존이 중요 — daemon이 `Date.now()`를 사용하면 sibling의 오래된 캐시가 "방금 fetch"로 위장됨
- Bridge/Daemon 양쪽에 동일 TTL 상수 적용으로 일관성 확보

---
