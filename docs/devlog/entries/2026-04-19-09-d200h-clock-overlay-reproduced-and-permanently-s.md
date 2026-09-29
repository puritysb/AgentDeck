# 2026-04-19 — D200H clock overlay — reproduced and permanently suppressed

### 문제
사용자 보고: D200H 실기기에서 "일부 흐릿하게 크리처는 보이는데 버튼이 제대로 안 나오고 눌러도 반응이 없고 오른쪽 아래에 기본 시계가 보이는" 증상. 덧붙여 "전에도 몇 번 이래서 고쳤던 적이 있다 — 왜 이런 상황이 종종 발생하는가"라는 메타 질문. `stock-safe-v19` 까지 renderer revision 이 올라가 있었던 것 자체가 반복 회귀의 화석 증거.

### 실제 근본 원인 (3겹)
1. **LaunchAgent 경합**. `dev.agentdeck.daemon` LaunchAgent 가 자동으로 Node CLI daemon 을 띄워 9120 을 선점 → Xcode Run 한 Swift 앱이 `external-client` 모드로 fallback → Swift in-process daemon 이 기동조차 하지 않아 수정된 코드가 실행되지 않음. Node 쪽 `bridge/src/modules/d200h-module.ts` (376줄) 는 Swift 쪽 (3053줄) 의 레거시 축소판이라 session list / option mode / usage monitor slot 13 / SVG 렌더러가 모두 없어, 사용자 눈에는 **단순 키 배열 + 기본 시계** 로 "퇴행" 돼 보임.
2. **Merged slot `3_2` manifest 의 Action 필드 trap**. `renderFullZip` 의 session-list 브랜치는 `clearAction: true` → `Action=""` 로 올바르게 설정해 stock smallwindow 레이어를 suppress 하지만, option-select 브랜치는 `actionPath: "agentdeck://back"` 으로 **펌웨어가 모르는 URI** 를 넣어 `Action=com.ulanzi.ulanzideck.system.open` 로 export → 펌웨어가 기본 smallwindow clock widget 을 fallback 으로 render. 같은 파일 내에 "올바른 방식" 과 "틀린 방식" 이 공존했다.
3. **`sendKeepAlive()` 오도된 복구 시도**. 당일 1차 수정에서 "기본 시계를 우리 텍스트로 덮자" 는 의도로 `CMD_SET_SMALL_WINDOW` 를 15초마다 push 하도록 재활성화했으나, D200H 펌웨어는 SMALL_WINDOW 레이어를 **manifest icon 과 같은 좌표 위에 합성** 하는 구조였다. 결과적으로 "usage 텍스트 + clock" 두 readout 이 동시에 보이는 새로운 "겹침" 증상을 추가 생성.

### 해결
**운영 (one-shot)**:
- `agentdeck daemon uninstall && pkill -f "agentdeck daemon start" ; launchctl remove dev.agentdeck.daemon` — LaunchAgent 영구 제거. 그 뒤 Swift in-process daemon 이 9120 을 잡는다.

**코드 (stock-safe-v19 → stock-safe-v20, `apple/AgentDeck/Daemon/Modules/D200hHidModule.swift` 한 파일)**:
- **`sendKeepAlive()` 함수 자체를 삭제**. 함수가 남아있으면 다음 누군가가 "호출 안 되는 dead code 같은데" 라며 다시 호출처를 추가할 리스크 — 실제로 오늘 사이클에서 발생.
- **Option-select 모드의 `3_2` entry 도 `clearAction: true` 로 통일**. 양쪽 호출부 두 군데 (`renderFullZip` `else` branch + `renderPartialZip` slot 13 branch).
- `buildSmallWindowPacket` 에 "TRAP: do NOT call from steady-state rendering" 주석.
- `manifestEntry` 에 "slot 3_2 는 반드시 `clearAction: true`" invariant 주석.
- 별개로 같은 날 추가한 가드들 (회귀 방지 효과 동일): `buildValidatedZip` 실패 시 `Data()` drop + 호출자 `zip.isEmpty` 체크, keyboard interface 2초 미연결 경고, input report buffer leak fix, `logOpenFailure` 레벨 debug→info.

### 검증
- `xcodebuild -project AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' build` — `** BUILD SUCCEEDED **`.
- 사용자 확인 (실기기 in-the-loop): "완전 해결되었다".
- Runtime `/health` 에 `rendererRev: 'stock-safe-v20'`, `sandboxEnabled: true`, `usbEntitlementPresent: true`, `managerOpened: true`, `hasConsumerDevice: true`, `hasKeyboardDevice: true` 기준.

### 핵심 설계 결정 (재발 방지 앵커)
- **Stock-clock 차단은 manifest-only 경로로 단일화**. SMALL_WINDOW 레이어로 "우리 텍스트를 올려 덮자" 는 유혹은 이번 사이클이 세 번째 시도였고 세 번 모두 악화. `Action=""` (`clearAction: true`) 이 **유일한** 확인된 escape hatch. 2026-04-12 1차 발견 → 2026-04-12 2차 혼동 ("smallwindow.window 유지" 로 revert) → 2026-04-19 재확립.
- **"dead function 이면 삭제한다"를 D200H 파일에 한정해 원칙화**. "일단 남겨두자" 는 관용이 `stock-safe-v19 → v20` 회귀 사이클의 원인 중 하나.
- **`3_2` entry 의 Action 필드 invariant 를 코드/로그/메모리 세 곳에 박음** — `manifestEntry` 주석, 이 entry, `memory/d200h-hid-protocol.md`. 다음 코더가 어떤 경로로 진입하든 "왜 Action 이 빈 문자열이어야 하는가" 에 즉시 도달.
- **펌웨어 경합의 해결은 OS 레벨 (LaunchAgent 제거) 에서만 가능**. 코드 수정으로는 풀 수 없다 — Swift daemon 이 실행조차 안 되는 상태라 어떤 `D200hHidModule` 변경도 무의미. 운영 플레이북에 명시.

### 관련 파일
- `apple/AgentDeck/Daemon/Modules/D200hHidModule.swift` (v19 → v20; `sendKeepAlive()` 삭제, option-mode `clearAction: true`, invariant 주석).
- `memory/d200h-hid-protocol.md` (SMALL_WINDOW 사용 금지 + manifest-only suppression 명문화).
- `~/.claude/plans/d200h-pure-goose.md` (진단 플랜 — 이 entry 로 대체됨).

---
