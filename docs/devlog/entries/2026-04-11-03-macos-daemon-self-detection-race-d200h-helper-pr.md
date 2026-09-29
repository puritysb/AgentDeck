# 2026-04-11 — macOS Daemon Self-Detection Race (D200H Helper Promotion)

### 문제
macOS 앱 실행 시 데몬이 포트 9120에 정상 바인드된 직후 health endpoint가 응답 불능 상태로 빠지고, 이후 "External daemon disappeared → 재시작 → 또 실패" 루프에 빠짐.

로그 패턴:
```
Server listening on port 9120
... (정상 가동)
Promoting D200H to bundled helper: ... lacks usable D200H USB entitlement
External daemon detected on port 9120 — connecting as client   ← 자기 자신
HTTP load failed ... -1001 (timeout)
External daemon on port 9120 disappeared — promoting this app to own the daemon
```

### 원인
`DaemonService.startBundledD200HHelper()`가 target port를 probe해서 `mode: "daemon"` 응답이 오면 early-return으로 `connectToExternalDaemon()`을 호출. 하지만 sandbox 빌드에서 D200H USB 권한이 없을 때 health monitor가 이 함수를 호출하면, probe가 **자기 자신의 로컬 데몬**에 도달해 self-detection이 발생. `connectToExternalDaemon()`이 `self.server = nil`로 로컬 DaemonServer를 orphan시키고 HTTP 응답이 끊김.

### 해결
`/health` 엔드포인트가 이미 `ProcessInfo.processInfo.processIdentifier`를 `pid` 필드로 반환 (`DaemonServer.swift:549`). 이를 자신의 PID와 비교하여 self-detection을 구분:

```swift
let remotePid = health["pid"] as? Int
let myPid = Int(ProcessInfo.processInfo.processIdentifier)
if remotePid != myPid {
    await connectToExternalDaemon(port: targetPort)
    return
}
// self-detection → 기존 fall-through: stop() + spawn bundled helper
```

부수적으로 `promotionTargetPort` / `resolvedSessionOverridePort` / `syncResolvedPortState` 헬퍼로 port resolution 로직을 재사용 가능하게 리팩터.

### 핵심 설계 결정
- **PID는 in-process daemon self-detection의 authoritative signal.** 로컬 Swift 데몬과 외부 Node helper는 항상 다른 PID를 가지므로 `/health.pid == ProcessInfo.processIdentifier`는 정확한 self-check.
- **Self-detect 시 fall-through가 의도**: 사용자가 `autoUseBundledD200HHelper=true`로 설정했다면 sandbox 데몬을 bundled helper로 교체하는 것이 본래 목적. 단 local daemon을 `connectToExternalDaemon()`으로 orphan하는 것만 금지.
- **잔여 이슈**: `stop()` 직후 helper가 동일 포트를 bind하려다 TIME_WAIT에 막히는 별도 문제가 있음 — helper 측 TIME_WAIT 재시도 로직 필요 (다음 세션).

---
