# 2026-07-19 — Swift 데몬을 메인 액터에서 분리 (@DaemonActor)

### 문제

Debug 빌드의 Terrarium 애니메이션이 메인 런루프를 포화시키자(렌더 83%, 유휴 0%) 데몬이 먹통이 됐다 — `/health` 5초 무응답, 데몬 로그 24분 정지, 그런데 프로세스는 살아 있고 WebSocket 트래픽은 계속 흘렀다.

이 **HTTP 죽고 WS 사는 비대칭**이 진단을 두 번 잘못된 파일로 보냈다. 실제 원인은 `DaemonServer` 가 `@MainActor` 라서, WS 리스너(전용 `ioQueue`)가 받아낸 HTTP 요청의 **핸들러**가 메인 액터에서 굶은 것이었다.

### 해결

- **`@DaemonActor` global actor 신설** (`apple/AgentDeck/Daemon/Core/DaemonActor.swift`). `DaemonServer` + 상태 보유 협력자 5개(`StateMachine`·`ModuleManager`·`ApmeCollector`·`OpenCodeObserver`·`ESP32WifiOtaManager`)가 동승. UI 타입(`DaemonVoiceAssistant`·`ReviewPanelPresenter`·`DaemonService`)은 `@MainActor` 유지하고 `await` 로 호출 (`578bfba6`).
- **선(先)경화**: 플립 전에 순서·원자성 의존 지점을 먼저 고정 — `/task/close` 의 두 컬렉터 읽기를 단일 격리 메서드로 승격, `handleCommand` 동기 유지 불변식, check-then-set 구역 명문화, `conn.isDisconnected` 가드 9곳 감사 (`98261bd1`). 양쪽 격리에서 모두 옳아 단독 revert 가능.
- **포트 재시도 사각지대**: CLI 데몬 종료 후 앱이 포트를 못 되찾고 포기했다. `syncResolvedPortState` 가 `sessionOverridePort` 만 설정하고 `fallbackAttempted` 는 남겨둬, 폴백 fast-path(`onDefault` 필요)와 포트 전진(`fallbackAttempted` 필요)이 **동시에 닫혔다**. 9120 이 비어 있는 걸 진단 로그가 출력하면서도 죽은 9121 만 재시도했다 (`157baf93`).

### 핵심 설계 결정

**`actor DaemonServer` 가 아니라 global actor.** 데몬은 단일 객체가 아니다. `StateMachine`(호출 87곳)·`ApmeCollector`(18곳)가 동기 값반환 메서드와 non-Sendable `[String: Any]` 를 쓰므로, 독립 actor 화는 ~105 호출부를 `await`+Sendable 경계로 만든다. 평범한 클래스로 두면 **자체 격리가 없어 내부 `Task {}` 가 상속할 대상이 없다**(`StateMachine.resetStuckTimer` 가 이걸로 깨졌다). 공유 global actor 만이 상호 호출을 동기로 유지하면서 격리 상속을 `@MainActor` 시절과 동일하게 보존한다 → **"의미론 동일, 실행자만 다름"**.

**Swift 6 통과가 안전을 보장하지 않는다.** 데이터 레이스는 전수 검증되지만 실행자 가정은 못 잡는다. 격리된 메서드 **안에 인라인으로** 쓴 `@convention(c)` 콜백은 그 격리를 정적으로 상속하는데, 함수 포인터는 격리를 실을 수 없어 Swift 가 진입점에 런타임 단언을 넣는다. IOKit 전원 알림이 이걸로 기동 수십 초 뒤 앱을 죽였다 — 빌드도 테스트도 초록인 채로. 해법은 콜백을 **파일 스코프**로 빼는 것(`daemonWakeCallback`).

**진단이 세 번 틀렸고 그 경위를 코드에 남겼다.** `HTTPServer` 의 `.main` 큐와 SO_REUSEADDR 누락이 WS 와의 비대칭·커밋 이력·증상과 전부 맞아떨어졌지만, **`HTTPServer.start(port:)` 는 테스트 말고 호출부가 없는 죽은 코드**였다. 호출부 grep 한 번이면 걸렀을 것을 커밋 3개 쌓은 뒤에 발견했다. `1a7312d3` 이 그 사실을 `HTTPServer` 헤더·테스트 주석·`docs/architecture.md` 에 박아 다음 사람이 같은 파일로 가지 않게 했다. 포트 건도 "TIME_WAIT + 짧은 예산" 으로 오진했다 — 예산을 늘렸다면 아무것도 안 고쳐졌다.

### 검증

459 테스트 통과. `DaemonActorIndependenceTests` 가 이 리팩터의 존재 이유를 고정한다 — 메인 스레드를 3초 고정한 채 데몬 작업이 진행되어야 하고, 같은 본문을 `@MainActor` 로 되돌리면 **타임아웃으로 실패**한다. 실기: 시스템 절전/복귀에서 `System wake` → Bonjour 재등록 → 전 모듈 복구(idotmatrix/timebox/serial/adb/pixoo) → Timebox 재연결 전 과정 확인.

**미검증**: ESP32 connect-burst 재진입, hook 턴 세션별 직렬성, 음성 콜백 왕복. 별건으로 강제 절전 직후 SwiftUI `TimelineView(.animation)` 렌더에서 SIGBUS 1건 — 스택에 이 리팩터 프레임이 없고 재현 안 됨. 이상 시 `git revert 578bfba6` 으로 격리만 되돌아간다.

---
