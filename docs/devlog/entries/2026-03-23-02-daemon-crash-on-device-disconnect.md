# 2026-03-23 — Daemon crash on device disconnect

### 문제
Dashboard 기기(ESP32, Android 등)가 끊어질 때 daemon이 크래시됨.

### 해결
`ws-server.ts`에서 3가지 크래시 경로 수정:
1. **Set iterator 무효화** — ping timer가 `wss.clients` Set을 순회하면서 `ws.terminate()` 호출 → ws 라이브러리가 Set에서 동기적으로 제거 → iterator 깨짐. Dead 클라이언트를 배열에 모은 후 루프 밖에서 terminate하도록 수정. `close()` 메서드도 `[...wss.clients]` spread.
2. **`send()` throw** — `readyState === OPEN` 체크 후에도 socket이 CLOSING으로 전이 가능 → `broadcast()`, `broadcastExcept()`, `sendTo()` 세 메서드에 try-catch 추가.
3. **SSE 초기 write** (`hook-server.ts`) — `writeHead()` 직후 클라이언트 즉시 끊김 시 state snapshot write에서 throw → try-catch 추가.

### 교훈
- `ws` 라이브러리의 `wss.clients`는 live Set — `terminate()`/`close()` 호출 시 동기적으로 수정됨. 순회 중 변경 불가.
- `readyState` 체크는 TOCTOU 취약 — `send()`는 항상 try-catch 필요.

---
