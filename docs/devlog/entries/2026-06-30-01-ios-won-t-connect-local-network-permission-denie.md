# 2026-06-30 — iOS "won't connect" = Local Network permission denied (surface an in-app prompt)

### 문제
iPhone(새 번들 `bound.serendipity.agent.deck`)의 대시보드 앱이 데몬에 "접속 안 됨". 라이브 기기 진단 결과 토큰/네트워크/데몬은 모두 정상(`~/.agentdeck/auth-token` == mDNS TXT, 데몬 healthy)이었고, flapping이나 dual-home도 아니었다. `devicectl … process launch --console`로 앱 stdout을 직접 잡으니 진짜 원인이 드러남: NWBrowser가 `waiting(-65570: PolicyDenied)` 루프 — **iOS 로컬 네트워크 권한이 거부 상태**라 mDNS 검색이 0개를 반환하고 영영 연결 못 함. 앱은 `.waiting`을 "권한이 방금 바뀐 줄 알고" `restartBrowser()`만 무한 반복할 뿐 사용자에게 아무 안내가 없었다(외부 유저는 원인을 알 수 없음). 권한을 켜자 즉시 `resolved → connecting → first message received — connected!`로 복구되어 단일 원인임을 확인.

### 해결
- **`BridgeDiscovery.swift`**: `NWBrowser.State.waiting(error)`에서 PolicyDenied(`-65570` / description fallback)를 감지해 `@Published localNetworkDenied` 플래그를 올림. 거부 루프의 ready→waiting flicker는 debounce(`.ready` 2초 유지 시에만 clear, `browseResultsChanged` 시 즉시 clear)로 처리.
- **`ConnectionOverlay.swift`**: `localNetworkDenied`일 때 "Local Network access is off" 카드 + iOS는 `UIApplication.openSettingsURLString`로 **[Open Settings]** 버튼, macOS는 System Settings 경로 안내. 무한 "Searching…" 대신 명확한 행동 유도.
- **`BridgeConnection.swift`** (secondary, keepalive 견고화): 주기 keepalive ping에 **5초 timeout** 추가(없었음 — URLSessionWebSocketTask `sendPing` completion은 stall 시 60초 receive timeout까지 hang → 데몬 15s eviction을 한참 넘김), repo의 "모든 외부 await에 timeout" 규약 준수. ping 간격 15s→8s(데몬 eviction 2× 마진), 첫 ping 2초, ±jitter. 죽은 상수 `maxReconnectAttempts=20` vs 실제 5 정리.

### 핵심 설계 결정
- "접속 안 됨" 디버깅은 **앱 stdout(`--console`)이 ground truth** — `idevicesyslog`는 앱 `print()`를 못 잡고(os_log만), 화면 캡처는 DDI 필요. CFNetwork `Sent ping N` os_log는 잡히지만 connection liveness 추론에만 유용.
- 로컬 네트워크 권한은 TCC라 코드로 못 켬 → 거부를 first-class 상태로 감지해 Settings 딥링크 유도가 정답(App Review-safe: 컴패니언 설치 유도 아님, OS 권한 재요청).
- **함정**: iPhone에 이름이 같은 "AgentDeck" 앱이 둘(`agent.deck` 0.1.0 신규 + `agentdeck.dashboard` 1.0.7 구) 깔려 둘 다 데몬에 붙어 clients 카운트(6~10)를 출렁이게 함. 구 앱이 권한 살아있어 안정 연결(ping 263, 15s)이라 신 앱 진단을 흐렸음.

### 검증
- iOS·macOS `BUILD SUCCEEDED`. iPhone에 dev 서명 빌드 배포 후 `--console`로 권한 grant→`connected!` 확인. 권한 카드는 실제 `PolicyDenied` 로그 신호에 직접 매칭(컴파일 검증).
