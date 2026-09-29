# 2026-04-12 — Sibling session state cache (OpenClaw flicker fix)

### 문제
Android 태블릿/e-book에서 OpenClaw sibling 세션이 간헐적으로 비정상 상태로 표시됐다가 금방 복구. 모든 기기가 동시에 영향 받음.

### 해결
`session-aggregator.ts`에서 sibling `/health` fetch 실패 시(2초 타임아웃) `state: undefined`를 그대로 전파하던 것이 원인. `siblingStateCache` (Map<sessionId, {state, modelName}>)를 추가하여 fetch 성공 시 캐시 저장, 실패 시 캐시된 last-known state 반환. `session-registry.ts`의 `deregister()`에서 캐시 정리.

### 핵심 설계 결정
**Sibling state는 stale > undefined.** 10초 폴링 주기에서 1회 타임아웃은 최대 10초의 stale state를 의미하지만, undefined 전파는 모든 클라이언트에서 크리처 깜빡임을 유발. Stale이 UX 관점에서 항상 낫다.

---
