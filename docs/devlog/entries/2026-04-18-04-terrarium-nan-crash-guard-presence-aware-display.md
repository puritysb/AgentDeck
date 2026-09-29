# 2026-04-18 — Terrarium NaN Crash Guard + Presence-Aware display_state + D200H Suppression

### 문제
1. Xcode 런타임 크래시: `WaterEffect.drawCausticLayer` at line 93
   (`let wave = sin(freq2 * t + time * 0.85 + linePhase) * amp`). 디스플레이
   sleep/wake, 창 최소화, 최초 레이아웃 등 Canvas 가 degenerate size(0 또는
   NaN/Inf) 를 전달할 때, `waveLen2 = w * 0.32 = 0` → `freq2 = 2π/0 = +Inf` →
   `sin(Inf*t) = NaN` → `CGPoint(NaN, NaN)` 가 Path.addLine(to:) 로 들어가면서
   CoreGraphics 가 트랩. 크래시 사이트로 표시된 line 93 은 NaN 이 *생성*되는
   지점일 뿐 실제 트랩은 그 직후.
2. `display_state` 이벤트가 **"모니터가 실제로 꺼짐"** 만 감지. 다음 상태에선
   Pixoo/ESP32/Android/D200H 가 계속 대시보드를 송출: 화면잠금(⌃⌘Q),
   스크린세이버 실행, Fast User Switching. 즉 자리를 뜨고 잠갔을 때도 기기가
   밝게 켜져 있어 외부 노출 + 전력 낭비.
3. D200H 는 아예 `display_state` 를 구독하지 않아 모니터가 꺼진 상황에서도
   15초마다 45~50KB set_buttons ZIP 을 계속 USB 로 푸시.
4. `LaunchSessionDialog.pickFolder()` 의 `NSOpenPanel.runModal()` 가
   `Unable to display open panel: your app is missing the User Selected File
   Read app sandbox entitlement` 으로 실패. `AgentDeck-Debug.entitlements`
   에는 키가 있지만 Debug/Release 둘 다 `AgentDeck.entitlements` 를 쓰고
   이쪽에 누락. `AgentDeck-Debug.entitlements` 는 프로젝트 참조만 있는 orphan.
5. 동일 다이얼로그의 Picker 가 `the selection "iterm" is invalid and does not
   have an associated tag` 경고. `@AppStorage("launch.lastTerminal") = "iterm"`
   복원 후 첫 렌더에 `installedTerminals = [.system]` 만 들어있어 태그 매칭 실패,
   `onAppear` 에서 채워지기 전에 Picker 가 이미 그려졌기 때문.

### 해결
**5aac12ba — Terrarium size guard** (`WaterEffect` + 6 sister files)
- 각 `draw(context:size:)` 진입 직후:
  ```swift
  guard size.width > 0, size.height > 0,
        size.width.isFinite, size.height.isFinite else { return }
  ```
- degenerate size 에선 한 프레임 스킵이 정답. 이후 모든 수식이 유한치.
- 적용 파일: `WaterEffect`, `KelpField`, `LightRaySystem`, `PlanktonSystem`,
  `RockFormation`, `SandDisturbance`, `WaterSurface`.

**27d2494e — DisplayMonitor 확장 + D200H 구독**
- `DisplayMonitor` actor 에 네 개 입력을 합성해 단일 `displayOn` 방송.
  ```
  displayOn = !isDisplayAsleep       (CGDisplayIsAsleep, 2s 폴링 — 기존)
           && !isScreenLocked        (com.apple.screenIsLocked / Unlocked)
           && !isScreensaverActive   (com.apple.screensaver.didstart / didstop)
           && !isSessionInactive     (NSWorkspace.sessionDid{Resign,Become}Active)
  ```
- `DistributedNotificationCenter` 과 `NSWorkspace.shared.notificationCenter`
  만 사용 — **전부 public API**. 추가 entitlement 없음, App Store 리뷰 이슈 없음.
  CGS 프라이빗 함수(`CGSSessionScreenIsLocked` 등) 회피.
- 기존 `onStateChanged` 콜백 API 그대로 → DaemonServer 변경 불필요 (해당
  레이어는 hardware-only 시절의 `display_state` 브로드캐스트만 그대로 씀).
- `D200hHidModule.handleBroadcast` 에 `case "display_state"` 추가:
  - off: `CMD_SET_BRIGHTNESS 0` 1회 전송 + `displaySuppressed=true`. 이후
    `updateDisplay()` 는 dim flag 에서 조기 return → 15s heartbeat 에서
    호출돼도 USB 쓰기 안 함.
  - on: `CMD_SET_BRIGHTNESS 100` + `lastStateHash=""`, `lastFullSlots=[]`
    리셋 후 full refresh.
  - `initializeDevice()` 는 현재 `displaySuppressed` 를 체크해 재연결 시에도
    dim 상태를 유지. 즉 호스트가 잠겨 있는 동안 D200H 를 탈착 후 재부착해도
    깜빡 대시보드 flash 가 없음.

**38a15e7a — 샌드박스 폴더 피커 + Picker 초기 태그**
- `AgentDeck.entitlements` 에 `com.apple.security.files.user-selected.read-only`
  추가. NSOpenPanel 이 열리려면 이 키가 유일한 요건. write 필요 없음
  (선택 경로는 string 으로만 보관되고 자식 프로세스가 상속).
- `LaunchSessionDialog.swift:13`: `installedTerminals` 초기값을
  `[.system]` → `TerminalApp.installed()` 로. @State 이니셜라이저에서 한 번
  평가 → 첫 렌더부터 모든 설치 터미널 태그 존재.

### 핵심 설계 결정
- **`display_state` 의미 확장**: "모니터 전원" → "사용자 존재 AND 모니터 전원".
  이벤트 이름과 downstream 소비자 계약은 그대로 유지 (Pixoo/ESP32/Android 가
  이미 신뢰하는 경로). 합성 책임을 `DisplayMonitor` actor 내부로 격리해서,
  새 입력(예: 노트북 lid-closed 상태) 추가 시 한 곳만 바꾸면 됨.
- **D200H suppression 전략**: 디바이스 펌웨어는 30초 후 기본 시계 화면으로
  복귀하지만, brightness 0 이면 시각적으로 동일. 그래서 heartbeat 중단이
  안전 — 깨어날 때 `lastStateHash=""` 로 강제 재송출해 복구.
- **App Store 호환성 점검**: 이번에 사용한 모든 입력(`com.apple.screenIsLocked`,
  `com.apple.screensaver.didstart`, `NSWorkspace.sessionDid{Resign,Become}Active`)
  은 DistributedNotificationCenter / AppKit public 경로로, 샌드박스 내에서
  권한 추가 없이 동작. 리뷰 노트에 "detect user presence to dim connected
  accessories when the Mac is unattended" 한 줄만 준비하면 충분.
- **엔티틀먼트 최소주의**: 폴더 피커에 `user-selected.read-only` 로 충분할 때
  `read-write` 를 넣지 않음. 앱이 실제로 선택 경로에 쓰기 시작하면 그때 업그레이드.

---
