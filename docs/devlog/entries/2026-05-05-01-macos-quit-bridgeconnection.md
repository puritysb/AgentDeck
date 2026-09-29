# 2026-05-05 — macOS Quit 후 BridgeConnection 재접속 루프 차단

### 문제

메뉴바 Quit 또는 Cmd+Q 종료 중 in-process daemon 은 `Daemon stopped` 까지 정상 shutdown 되지만,
dashboard 쪽 `BridgeConnection` / stale-data watchdog / mDNS discovery 가 종료 상태를 모르고
`ws://127.0.0.1:9120` 재접속을 계속 예약했다. 그 결과 daemon 종료 직후 `Connection refused`
로그가 반복되고 앱이 살아 있는 것처럼 보였다.

### 해결

- `AgentStateHolder.prepareForTermination()` 추가. Quit 시 preferred local bridge, auto-connect
  timer, stale monitor, wake listener, discovery, bridge connection 을 먼저 종료 모드로 전환한다.
- `BridgeConnection.prepareForTermination()` 추가. WebSocket, URLSession, ping timer, reconnect
  work item 을 취소하고 이후 `connectInternal` / receive callback / ping / reconnect 가 재진입하지
  않도록 termination guard 를 둔다.
- `BridgeDiscovery.prepareForTermination()` 추가. NWBrowser restart 예약과 late resolve/health
  callback 이 종료 중 bridge list 를 다시 채우지 못하게 guard 한다.
- 메뉴바 Quit 은 daemon 을 직접 stop 하지 않고 `NSApplication.terminate` 로 단일 종료 경로에
  위임한다. AppDelegate 는 daemon shutdown 전에 dashboard-side reconnect loop 를 먼저 끈다.

### 검증

- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination platform=macOS -derivedDataPath /tmp/AgentDeckDerivedDataQuitFix build CODE_SIGNING_ALLOWED=NO`
  성공.

---
