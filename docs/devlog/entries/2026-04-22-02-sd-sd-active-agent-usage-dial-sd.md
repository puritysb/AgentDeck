# 2026-04-22 — SD/SD+ active-agent 시각 강화 + USAGE dial 라벨 정직화 + SD 플러그인 설치 감지

### 문제

세 건의 UX 지적이 한 세션에서 나옴:

1. **"진행 중 에이전트 표시가 너무 눈에 안 띈다"** — SD/SD+/D200H 모두 세션 버튼 우상단에 16×16 회전 스피너 한 개만 있어 세 세션이 동시에 뜨면 어느 것이 실제로 돌고 있는지 한눈에 판별이 안 됨. AWAITING_PERMISSION 은 이미 2.5px 펄스 테두리가 있는데 PROCESSING 은 테두리 자체가 없었음.
2. **SD+ USAGE dial 이 "Waiting..." 으로 계속 보인다** — API-key 계정·App Store 샌드박스처럼 **영원히 usage 데이터가 안 오는** 케이스도 "Waiting" 이어서 "곧 올 것처럼" 보이는 오해 유발.
3. **메뉴바에 "Install SD plugin" 링크가 이미 설치된 상태에서도 뜬다** — 링크도 번들된 `.streamDeckPlugin` 이 없으면 `github.com/.../releases/latest` 로 떨어져 실사용자에게 불친절.

### 해결

**A. 세션 타일 테두리 — flowing light (3 파일)**

- `shared/src/svg-renderers/session-slot-renderer.ts`: PROCESSING 에 dashed flowing border 신설. `stroke-dasharray="22 14"`, `stroke-dashoffset = (animFrame * 4) % perimeter` 드리프트, Gaussian blur 필터, 4.5px 외부 + 1.5px 내부 이중 링. AWAITING 펄스도 2.5→4.5px 로 굵기 강화 + sin opacity 범위 0.55~1.0 + 내부 링 추가. 우상단 회전 스타 스피너 제거, ACT 뱃지는 IDLE 전용으로 축소.
- `plugin/src/actions/session-slot-button.ts`: `needsAnimation()` 이 `awaiting*` 만 true 반환해서 PROCESSING 일 땐 150ms 타이머가 아예 안 돌고 있었음 — `animFrame` 이 0 에 고정돼 dashoffset 이 정지. `session.state === 'processing'` 체크 추가 후 애니메이션 활성화.
- `apple/AgentDeck/Daemon/Modules/D200hHidModule.swift`: 스테이블-스톡 HID 모드에서 세션 타일이 `.solid(color)` 로 떨어지던 fallback 제거 (lineWidth 2, alpha 0.6 → 너무 얇음). 항상 `.awaitingPulse` / `.processingDash` 를 emit, 스테이블 모드에선 애니 루프가 `setNeedsAnimation` 에서 강제 off 되므로 정적 스냅샷이 됨. 펄스 frame 을 5 로 pin 해서 sin peak (≈0.997) 에 고정 (0 frame 이면 opacity ≈0.3 어둡게 걸림). `.processingDash` draw 자체도 lineWidth 3→5, shadow blur 8 추가, crisp 내부 pass 추가.

**B. USAGE dial 라벨 정직화 (2 파일)**

- `plugin/src/renderers/usage-dial-renderer.ts`: `renderUsageDisconnected(connected, reason)` 시그니처에 `reason: 'offline' | 'waiting' | 'unavailable'` 추가. "No usage data" 라벨 신설.
- `plugin/src/actions/iterm-dial.ts`: 호출부를 세 분기로 재작성 — (a) 세션 disconnected → 'offline', (b) 접속됐으나 `hasReceivedData=false` → 'waiting', (c) `usageStale === true` 또는 `fiveHourPercent == null` → 'unavailable'.

**C. SD 플러그인 설치 감지 (1 파일)**

- `apple/AgentDeck/UI/MenuBar/ControlTowerPanel.swift`: `StreamDeckDetection` 에 `pluginInstalled: Bool` 필드 추가. `detectPluginInstalled()` 가 `getpwuid(getuid())` 로 real home 을 얻고 `~/Library/Application Support/com.elgato.StreamDeck/Plugins/bound.serendipity.agentdeck.sdPlugin/manifest.json` 존재 확인 — 2026-04-16 `swift-daemon-server.md` 메모리 노트의 기법 재사용. `streamDeckPromptCompact` 가 이제 `{SD+ connected, Elgato app present, plugin not installed}` 3조건 모두 충족해야만 "Install SD plugin" 렌더, 아니면 버튼 자체가 안 뜸.

### 핵심 설계 결정

- **D200H 는 라이브 애니 없이 "정적이지만 굵은 glow"**: 유저가 SD/SD+ 만 흐르는 애니메이션, D200H 는 정적 썰매를 택함. D200H 는 프레임 루프 추가 비용(14 PNG resvg/Core Graphics 재렌더 × ~8fps) 이 지나치게 크고, 스테이블-스톡 HID 모드는 애니 루프 자체가 금지됨. 같은 SVG 가 SD/SD+ 에선 150ms 틱에 dashoffset 이 움직이고, D200H 에선 `animFrame` 이 한 값에 고정돼 자연스럽게 정적 dashed glow ring 으로 렌더된다는 "동일 코드 경로, 다른 틱 상황" 설계로 해결.
- **샌드박스 경로 체크는 silent-false 허용**: `detectPluginInstalled()` 가 App Sandbox 하에서 Elgato Plugins 폴더 읽기가 막히면 조용히 `false` 반환. App Store 빌드에선 최악의 경우 "Install SD plugin" 을 한 번 더 보지만, 이 nudge 는 원래부터 hint 일 뿐 gate 가 아니므로 허용 가능한 fallback. home-relative-path entitlement 재도입보다 UX 퇴행이 낫다 (App Store 2.5.2 invariant 보존).
- **USAGE 라벨 3분기는 의도적으로 `fiveHourPercent == null` 을 "unavailable" 에 포함**: 서버사이드에서 수치를 낼 수 없는 경우(OAuth 없는 API-key 계정 등) 와 "곧 올 것" 의 의미 경계를 **플러그인에서** 넷째 경우로 가정하지 않고, daemon 이 이미 unavailable 로 판정한 것(`usageStale=true`)이든 애초에 값 자체가 없는 것이든 **동일 라벨**로 묶음. 사용자 입장에선 "안 오는 것" 은 구분 의미 없음.

---
