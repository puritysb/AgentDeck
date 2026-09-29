# 2026-04-12 — D200H usage panorama density + billing label

### 변경
- D200H stock HID 사용량 영역을 `stock-safe-v7`로 갱신.
- 5H/7D 리셋 시간을 11pt 보조 텍스트에서 17pt 주요 텍스트로 키우고, 24시간 이상은 `5d`, `1d4h` 같은 날짜 기반 compact 표기로 환산.
- 사용량 리셋 텍스트의 `LEFT` suffix를 제거하고, 진행 바를 아래로 내려 병합 2칸의 세로 공간을 더 사용.
- `subscriptions[].until` 또는 `codexSubscriptionActiveUntil` 값이 있으면 하단에 `ChatGPT Plus Apr 19`처럼 서비스명과 다음 구독 날짜만 표시. `RENEW` prefix는 사용하지 않음.
- D200H OpenClaw 타일은 별도 Swift path renderer를 타므로 icon rect를 키우고 renderer rev를 올려 실제 PNG와 파일명이 함께 바뀌도록 조정.
- D200H의 virtual OpenClaw gateway 세션은 버튼 제목을 `Gateway`가 아니라 `OpenClaw`로 표시하고, 모델명이 없을 때 상태 텍스트가 실제 버튼 하단 마스크에 붙지 않도록 텍스트 stack을 위로 이동.
- D200H 재부팅 직후 기본 시계 small-window 레이어가 13번 merged usage 영역에 겹치는 문제를 막기 위해, `3_2` usage manifest에서 `com.ulanzi.ulanzideck.smallwindow.window` action을 제거하고 빈 action으로 명시적으로 clear.
- `tools/creature-simulator/index.html`의 D200H merged usage preview도 동일한 리셋/구독일 샘플과 OpenClaw 텍스트 위치 조정을 반영.

### 검증
- `swiftc -parse apple/AgentDeck/Daemon/Modules/D200hHidModule.swift` 성공.
- `node --check scripts/render-creature-simulator.mjs` 성공.
- `pnpm --filter @agentdeck/bridge typecheck` 성공.
- `git diff --check -- apple/AgentDeck/Daemon/Modules/D200hHidModule.swift bridge/src/d200h/image-renderer.ts tools/creature-simulator/index.html DEVELOPMENT_LOG.md` 성공.
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'generic/platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataD200HUsagePanoramaV5 build` 성공.
- Runtime `/status`: `d200h.rendererRev=stock-safe-v7`, `connected=true`, `writeFail=0`, `managerOpened=true`.
- 최신 D200H dump `20260412-134326-178-set_buttons-L-52139b-OPENCLAW___.zip`: `manifest["3_2"]`가 `Action=""`인 일반 icon entry로 `icons/btn13-wide-stock-safe-v7-2f203781.png` 참조, PNG 크기 392x196. 실제 PNG는 `LEFT`/`RENEW` 없이 `2h17m`, `4d20h`, `ChatGPT Plus Apr 19`로 렌더링.
- stock-safe-v16: D200H 2칸 usage 버튼을 Stream Deck+ overview 정보 구조에 맞춰 재구성. `USAGE` 헤더, 5H/7D segment gauge, percent, reset time, 구독 결제일, 하단 accent bar만 남기고 D200H safe area에 맞춰 2배 스케일로 배치.
- stock-safe-v17: V16 usage 레이아웃을 소폭 상단 이동하고 하단 구독 결제일/색상 accent가 D200H 실제 버튼 하단 경계에 붙지 않도록 bottom safe area를 확장. 시뮬레이터 D200H 텍스트도 Swift 렌더러와 같은 HelveticaNeue 계열로 통일.
- stock-safe-v19: D200H usage 하단 accent bar가 실제 버튼 경계선처럼 보여 텍스트와 하단 마스크를 더 붙어 보이게 하므로 제거. 구독 결제일 텍스트만 위쪽 safe area에 배치.

---
