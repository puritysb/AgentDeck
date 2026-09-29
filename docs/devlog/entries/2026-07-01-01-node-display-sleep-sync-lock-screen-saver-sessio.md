# 2026-07-01 — Node display sleep sync: lock/screen saver/session presence parity

### 문제
사용자가 `cmd+shift+eject` 로 즉시 모니터를 끄면 dashboard 기기들이 대부분 꺼지지만, 장시간 유휴 → macOS 잠금 화면 유지 → 이후 모니터 sleep 경로에서는 일부 기기가 계속 켜질 수 있다고 보고했다. 점검 결과 Swift in-process daemon 은 display asleep + screen lock + screensaver + session inactive 를 합성해 `display_state{displayOn:false}` 를 보내지만, Node CLI daemon 의 `DisplayMonitor` 는 `CGDisplayIsAsleep()`/`pmset IODisplayWrangler` 만 보고 있었다. 즉 잠금 시점에는 fan-out 이 없고, 이후 display sleep 감지도 메인 display/power-state 신호에 의존해 외부 모니터·잠금 화면 경로에서 놓칠 여지가 있었다.

### 해결
- Node `bridge/src/display-monitor.ts` 를 Swift 와 같은 의미의 composite monitor 로 변경: `displayAsleepByCG`, `displayAsleepByPower`, `screenLocked`, `screensaverActive`, `sessionInactive` 를 별도 저장하고 합성값이 바뀔 때만 `display_state` 를 emit.
- fallback poll 이 `pmset` 외에 `ioreg -n Root -d1` 의 `CGSSessionScreenIsLocked` / `CGSSessionOnConsoleKey`, `pgrep -x ScreenSaverEngine` 를 함께 본다.
- `BridgeCore.wireDisplayMonitor()` 는 listener 를 먼저 등록한 뒤 monitor 를 시작한다. 이미 잠긴 상태에서 데몬이 시작될 때 즉시 fallback poll 이 `display_state:false` 를 emit 해도 유실되지 않게 하기 위함.
- `isDisplayOn()` 과 `/display-state` 초기 응답도 합성값을 반환하므로 새로 붙은 Stream Deck/Android/ESP32/BLE sync 클라이언트가 잠금 중 밝게 살아나는 경로를 줄였다.
- `docs/plugin-conventions.md` 의 display sleep/wake sync 설명을 Node/Swift composite 의미로 갱신.

### 검증
- `parseIoregPresence` 회귀 테스트 추가.
- `pnpm --filter @agentdeck/bridge typecheck` 성공.
- `pnpm vitest run bridge/src/__tests__/tier3-integration.test.ts bridge/src/__tests__/display-dim.test.ts bridge/src/__tests__/bridge-core.test.ts` 성공.
- `pnpm build` 성공.
