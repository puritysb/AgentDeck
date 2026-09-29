# 2026-04-28 — Daemon bounded-read queue QoS + OpenClaw RPC 로깅

### 문제

macOS daemon 로그가 매 tick 마다 Thread Performance Checker priority-inversion 백트레이스로 도배됐다. `SessionRegistry / PixooModule / ApmeSettings / WifiConfig / UsageAPIClient / DaemonTimelineStore` 6 개 모듈이 모두 `.utility` QoS 의 dispatch queue 에서 `DispatchSemaphore.wait` 로 700 ms bounded read 를 흉내 냈는데, 호출자가 main actor (User-interactive) 나 `.userInitiated` Task 라 매번 "higher-QoS thread waiting on lower-QoS" 경고가 발생했다. 별도로 OpenClaw Gateway adapter 의 RPC 실패 로그가 `code ?? message ?? "unknown"` 의 `??` 체인을 써 `INVALID_REQUEST` 같은 코드가 있을 때 `message` 가 항상 묻혔다. 그 결과 `models.list` (별도 경로) 만 "missing scope: operator.read" 가 보이고, `sessions.subscribe / system-presence / sessions.list / logs.tail` 는 코드만 찍혀 진짜 원인이 안 드러났다.

### 해결

- 6 개 큐 QoS 를 `.userInteractive` 로 올렸다. 처음에는 `.userInitiated` 로 1차 수정했는데 (commit `3cf32895`) 그건 `.userInitiated` Task 호출자만 해결하고 main actor 호출자에게는 여전히 한 단계 inversion 이 남았다 (User-interactive → User-initiated). DaemonServer.startServices / ApmeRunner.init / probeMLX / startDeviceModules / TimelineStore.start / 초기 usage task / query_usage 핸들러가 모두 main actor 에서 sync wait 한다. 700 ms cap + 단일 `Data(contentsOf:)` 라 워커가 main actor critical path 위에 있는 짧은 구간만 .userInteractive 으로 도는 셈이라 정당화됨.
- `OpenClawAdapter` 의 RPC 실패 로그를 `code: message` 둘 다 찍게 바꿨다. `code` 가 있으면 `message` 도 같이 출력 → 다음 페어링 사이클부터 scope 미스매치가 즉시 보인다. 실제 scope grant 자체는 Gateway 서버 + 페어링 플로우 문제라 클라이언트로는 못 고친다.

### 핵심 설계 결정

- **Sync semaphore wait 패턴은 가장 높은 호출자 QoS 와 매칭해야 한다.** `.utility` 는 TPC 경고 보장. `.userInitiated` 는 main actor 가 호출하면 한 단계 inversion 이 남는다. main actor 호출자가 있는 큐는 `.userInteractive` 가 정답 (단, work 이 짧고 cap 있을 때만). 새 모듈은 호출 chain 부터 보고 결정해라.
- **Optional chain 으로 에러 컨텍스트를 합치지 마라.** `errorInfo?["code"] ?? errorInfo?["message"]` 같은 패턴은 한쪽만 흘려보내고 나머지를 영원히 가린다. 둘 다 보고 싶으면 `switch (code, message)` 로 분기.

---
