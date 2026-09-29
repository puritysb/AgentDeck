# 2026-04-13 — D200H Simulator-Parity Recovery

### 문제
`D200hHidModule.swift`의 워크트리 구현이 어느 순간 이전 형태로 돌아가 있었다. 실행 중인 바이너리는 `stock-safe-v8` 계열로 동작했지만 소스에는 renderer rev, stock-HID 안정 플래그, hash 기반 icon filename, 단일 wide usage image가 빠져 있어 다음 빌드/재실행 시 `btn13L/btn13R` 분할과 partial update 경로로 회귀할 수 있었다.

또한 `open`이 번들 ID 기준 LaunchServices 캐시를 따라 오래된 DerivedData 앱을 띄우는 경우가 있어, 실제 실행 경로와 방금 빌드한 앱 경로가 어긋날 수 있었다.

### 해결
- D200H renderer revision을 `stock-safe-v9`로 올리고 `lastStateHash`에 포함
- `stableStockHid=true` 경로를 고정해 partial update, press flash, animation payload 전송을 비활성화
- `btn13L/btn13R` manifest를 제거하고 `3_2` 하나만 사용. `4_2`는 생성하지 않으며, stale action 제거를 위해 `Action: ""`을 명시
- 모든 icon filename에 `stock-safe-v9`와 FNV-1a content hash를 포함
- `http://localhost:5173/` creature simulator의 현재 D200H 디자인 기준에 맞춰 세션 버튼 safe-area를 18px 카드 구조로 조정
- usage limits는 두 개의 버튼 PNG 합성이 아니라 `392x196` wide PNG를 직접 렌더. `LIMITS`, 5H/7D 퍼센트, compact reset time, ChatGPT 구독 결제일 라인을 분리 배치
- reset time은 `120h` 같은 시간 누적 표기가 아니라 `5d`, `4d9h` 형태의 compact day/hour 표기로 조정
- virtual OpenClaw gateway 표시명은 `Gateway`가 아니라 `OpenClaw`로 유지

### 검증
- `swiftc -parse apple/AgentDeck/Daemon/Modules/D200hHidModule.swift` - 성공
- `git diff --check -- apple/AgentDeck/Daemon/Modules/D200hHidModule.swift` - 성공
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'generic/platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataD200HRecoveryV9 build` - 성공
- Runtime `/status` on fallback port 9124: `rendererRev=stock-safe-v9`, `stableStockHid=true`, `partialUpdatesEnabled=false`, `connected=true`, `managerOpened=true`, `writeFail=0`
- 최신 dump ZIP: `icons/btn13-wide-stock-safe-v9-*.png` 하나만 포함, `btn13L/btn13R` 없음, manifest는 `3_2`만 사용하고 `Action: ""` 포함
- `/tmp/agentdeck-d200h-v9-preview2/btn13-wide-stock-safe-v9-d6a16a3d.png` 시각 확인: 퍼센트/reset/billing line 겹침 없음

### 후속 보정
- `stock-safe-v11`: D200H 실제 버튼 마스크에서 하단 경계가 묻히지 않도록 세션 텍스트 블록과 usage billing line을 위로 이동
- OpenClaw 버튼은 크리처를 조금 키워 아래로 내리고 텍스트 블록은 위로 올려, 크리처와 텍스트 사이 공백 및 `STANDBY` 하단 경계 접근 문제를 완화
- `tools/creature-simulator/index.html`의 D200H 세션 텍스트 좌표도 같은 방향으로 업데이트
- `stock-safe-v12`: 세션 아이콘은 유지하고 usage wide button만 다시 구성. 5H/7D를 하단에 몰린 두 칸 구조 대신 중앙부의 두 full-width row로 배치하고, Apple HUD 계열에서 쓰는 green/amber/red 잔여량 색상(`#22C55E`, `#FBBF24`, `#EF4444`)에 맞춤
- `stock-safe-v13`: D200H 실제 화면에서 V12의 작은 reset/billing 텍스트와 하단 치우침이 잘 보이지 않아 usage 버튼을 정보 절약형으로 재설계. 5H/7D 큰 퍼센트와 두꺼운 bar만 중앙 safe area에 배치하고, 구독 날짜는 있으면 상단 오른쪽의 짧은 날짜로만 표시
- `stock-safe-v14`: V13의 좌우 반쪽 카드 구조가 가로로 눌려 보이고 퍼센트/게이지 간격이 애매해, 5H/7D를 세로로 쌓은 row 구조로 변경. 각 row는 왼쪽에 label+percent, 오른쪽에 bar를 두고 구독 날짜는 `PLUS APR 19`처럼 맥락 있는 짧은 라벨로 표시

---
