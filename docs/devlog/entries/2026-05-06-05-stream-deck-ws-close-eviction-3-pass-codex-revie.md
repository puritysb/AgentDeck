# 2026-05-06 — Stream Deck WS-close eviction (3-pass Codex review)

### 문제

macOS Dashboard 의 Downstream rail 에서 Stream Deck row 가 보이지 않는 케이스를
조사하다가, 더 깊은 stale-row 문제가 드러났다. SD 플러그인이 죽거나 Elgato 앱을
끄면 `cachedStreamDeck` 가 최대 120 s 동안 살아남았다. Codex stop-time review 가
세 번 연달아 같은 영역을 잡아냈다 — 한 번에 하나씩 더 깊은 race 가 드러났다.

### 해결 (3-pass)

1. **WS-close hook 비어있음** — `handleClientDisconnect()` 가 stub 였다. WebSocket
   `onCommand` / `onClientDisconnect` 콜백이 `WebSocketConnection` 식별자를 버리고
   있어서 daemon 쪽에서 어떤 conn 이 죽었는지도 알 수 없었다. conn 을 콜백에
   plumb 하고, `StreamDeckRegistration` 에 `connectionId: UUID` 를 박아 conn-id
   매칭 시 즉시 evict 하도록 했다.
2. **`receive()` 의 `isComplete` 무시** — peer 가 0x8 close frame 없이 그냥 TCP
   FIN 만 보내면 (kill -9, `ws.terminate()`, 프로세스 크래시, 머신 sleep)
   receive 콜백은 `(content: nil, isComplete: true, error: nil)` 로 무한 재귀하고
   `onClose` 가 발화되지 않았다. `isComplete` 분기를 추가하고, 마지막 데이터와
   FIN 이 같은 콜백에 합쳐 들어오는 경우를 대비해 frame 처리 후에 검사하도록 순서를
   조정했다.
3. **MainActor Task 사이 FIFO 보장 안 됨** — `client_register` 페이로드 + FIN 이
   같은 패킷에 들어오면, `onMessage` 가 TaskA(handleClientRegister) 를, `onClose`
   가 TaskB(handleClientDisconnect) 를 연달아 schedule 하지만 Swift Concurrency 는
   독립 Task 의 MainActor 도달 순서를 보장하지 않는다. TaskB 가 먼저 돌면 cache 에
   아무것도 없어 no-op 후, TaskA 가 죽은 conn 으로 cache 를 채워 다시 stuck.
   `WebSocketConnection.markDisconnected()` 를 receive 콜백 내부에서 동기적으로
   set 하고, `handleClientRegister` 가 시작 직후 `conn.isDisconnected` 면 거부하는
   패턴으로 어느 Task 가 먼저 돌든 안전하게 만들었다.

### 핵심 설계 결정

- 외부 콜백/I/O 가 actor-isolated 데이터로 reach 할 때 race 를 막는 두 패턴:
  (A) Task 사이 FIFO 가 필요하면 actor 진입 전에 동기적으로 lock-protected flag 를
  세팅, (B) 가능하면 actor state 를 직접 만지지 않고 Sendable snapshot 으로 분리.
  같은 세션의 SerialEventSnapshot 패턴이 (B) 의 예.
- Codex stop-time review 는 컴파일/단위 테스트로 못 잡는 동시성 race 를 잡는다는
  점을 이번에 확인했다. 첫 fix 후 review 가 또 다른 race 를 짚을 때 "이미 고쳤음"
  으로 무시하지 말 것. 메모리: `feedback_codex_stoptime_iteration.md`.

### 검증

- macOS xcodebuild ✓ (3 라운드 모두), iOS xcodebuild ✓, plugin vitest 135/135 ✓.
- 런타임 검증: SD 플러그인 정상 announce → row 표시 확인. (kill -9 / 머신 sleep
  시나리오는 사용자 환경에서 추후 회귀 모니터링.)

---
