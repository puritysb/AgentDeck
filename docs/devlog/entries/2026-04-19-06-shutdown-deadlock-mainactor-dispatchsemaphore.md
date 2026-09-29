# 2026-04-19 — Shutdown deadlock 제거 (MainActor + DispatchSemaphore)

### 문제
`AppDelegate.applicationWillTerminate` 이 `DaemonService.stop()` 완료를 기다릴 때 `DispatchSemaphore.wait(timeout: 10s)` 로 main thread 를 블록하고 있었다. `stop()` 은 `@MainActor` isolated async 메서드라 실행하려면 main thread 가 필요한데, main 이 세마포어에서 자고 있으니 Task 가 깨어날 수 없다 → 10초 전부 소진 후 "Shutdown exceeded 10s — forcing exit" 로그로 강제 종료. Xcode Debug 실행을 반복하면 데몬 정리가 끝나기도 전에 프로세스가 죽어 `SX` 상태 좀비가 누적되는 원인이기도 했다 (`memory/xctest-zombie-blocker.md` 의 "Stop 버튼 → zombie" 경로).

### 해결
`apple/AgentDeck/App/AgentDeckApp.swift:186` — semaphore 대신 3초 deadline 동안 `RunLoop.main.run(mode: .default, before: +0.05s)` 를 반복해 pump 한다. `Task { @MainActor }` 가 windows 사이마다 흘러 들어가 `stop()` 이 끝나면 `done = true` 로 루프 탈출. 실측 `stop()` 은 client-mode 빌드에서 100ms 이하이므로 3초 failsafe 면 충분하다.

### 핵심 설계 결정
- MainActor-isolated async 를 기다릴 때 semaphore 는 무조건 deadlock. 교과서적인 패턴.
- `run(before:)` 짧은 창으로 pump 하는 이유: 한 번에 긴 `distantFuture` 를 주면 NSApplication 종료 event 와 경합. 50ms 슬라이스가 Task 실행 기회를 안정적으로 준다.

---
