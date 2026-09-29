# 2026-03-08 — Gateway 상태 boolean 고착 버그

### 문제
Android Dashboard에서 OpenClaw 가재가 한번 SICK 상태가 되면 gateway 복구 후에도 영구적으로 SICK 유지. `gatewayAvailable`도 동일하게 한번 `true`가 되면 gateway 종료 후에도 available로 인식.

### 해결
`bridge/src/index.ts`와 `bridge/src/daemon-server.ts`에서 `gatewayAvailable`/`gatewayHasError` 전송 시 `|| undefined` 패턴 사용이 원인. JS에서 `false || undefined` → `undefined`이므로 `false` 값이 전송되지 않고, Android 측 `?: current` Elvis 연산자가 null을 이전 값으로 대체하여 `true`가 고착됨. 4곳 모두 `|| undefined` 제거하여 boolean 값을 항상 명시적으로 전송하도록 수정.

### 교훈
- **boolean 필드에 `|| undefined` 금지**: `false`가 유의미한 값인 boolean에는 `??`를 쓰거나 항상 전송. `||`는 falsy(0, '', false, null, undefined)를 모두 탈락시킴
- **daemon-server.ts 동기화**: `index.ts`와 `daemon-server.ts`에 동일한 state broadcast 코드가 중복 존재 — 한쪽만 수정하면 다른 경로에서 재현됨

---
