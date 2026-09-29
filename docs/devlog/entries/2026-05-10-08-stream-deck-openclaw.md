# 2026-05-10 — Stream Deck OpenClaw 버튼: 모델 별칭 + 크리처 확대 + 세션별 회전 위상

### 문제

Stream Deck (정사각 144×144 키패드) OpenClaw 세션 버튼에서 세 가지 거슬림이 보고됨:

1. **모델명 줄임표**: `claude-sonnet-4-6` 같은 긴 문자열이 `claude-sonnet…` 로
   잘려서 추하게 보임. D200H 의 모델 표기는 같은 라이브러리가 같은 자르기
   규칙을 쓰는데도 가로폭 덕분에 자연스러워 보임.
2. **크리처가 너무 작다**: 48 px 워터마크 + opacity 0.42 라 답답함.
3. **회전 애니메이션 동기화**: PROCESSING 버튼이 여럿 있을 때 전부 같은
   `animFrame` 으로 perimeter 위 동일 위상에서 돌아 — 실제 진입 시점이
   다른데도 lockstep 애니메이션이라 어색.

### 해결

- `aliasModelName(name)` 신규 헬퍼 (`shared/src/svg-renderers/session-slot-renderer.ts`):
  `^claude-([a-z]+)-(\d+)-(\d+)(?:-\d+)?$` 정규식으로 `claude-sonnet-4-6 →
  sonnet 4.6`, `claude-haiku-4-5-20251001 → haiku 4.5` 등 매핑. 매칭 안되면
  원본 그대로 반환. `formatModelEffort` 가 truncate 전 한 번 통과시킴.
- 크리처 워터마크 48 → 72 px, opacity 0.42 → 0.55 (working) / 0.54 → 0.62
  (idle). `agentLogoIcon` 이 size 인자만 받아 동적 scale 하므로 한 줄 변경.
  D200H 도 같은 `renderSessionSlot` 을 호출하므로 동일하게 반영됨 — 사용자
  가 D200H 표기를 "적당하다" 평한 만큼 회귀가 아닌 일관성 개선.
- PROCESSING/AWAITING 진입 시점의 `animFrame` 을 `processingStartFrame:
  Map<sessionId, number>` 에 캡처. `renderOrbitingRect` 의 `phasePx =
  -(startFrame * speedPx) % BORDER_PERIMETER` 로 변환해 세션마다 perimeter
  위 시작점이 달라짐. 진입 시점이 같으면 동기, 다르면 비동기 — 실제
  타이밍에 맞는 자연스러운 위상.

### 핵심 설계 결정

- **wire protocol 미변경**: `processingStartedAt` 같은 새 필드를
  `SessionInfo`/`StateUpdateEvent` 에 추가하지 않음. 플러그인이 자체
  `animFrame` 으로 진입 시점을 재구성해도 phase 계산엔 충분 — 동일 세션
  이 ID 만 같으면 다음 진입 시 새 startFrame 으로 리셋됨.
- **animation restart 시 map clear**: `startAnimation()` 이 `animFrame = 0`
  으로 리셋하는데 stale map 엔트리가 남으면 phase 가 어긋남. clear 한 줄
  추가로 해결.
- **`renderSessionSlot` 만 손대고 D200H 전용 렌더러는 건드리지 않음**:
  D200H 가 같은 shared 함수를 호출한다는 사실은 재발견의 연속. 첫 패스
  에선 D200H `renderInfoButton('MODEL', state.modelName.slice(0,12))` 두
  곳을 의도적으로 건드리지 않고 보고 — 사용자가 D200H 표기를 이미
  좋다고 했고 review item 이 Stream Deck 한정이라.
- **stop-time review 가 잡은 1차 누락**: 첫 commit 은 session-slot SVG
  renderer (`renderSessionSlot`) 와 `renderDetailInfo` 만 alias 통과시켰
  지만, `SessionSlotManager.modelStatusCard()` 와 OpenClaw model preset
  subtitle (line 612 부근) 은 raw `modelName` 을 직접 truncateStr 로
  넘기고 있었음. detail view 의 MODEL 카드 / preset 버튼이 alias 미적용.
  Codex stop-time review 가 "model alias is incomplete on Stream Deck
  detail model cards" 로 짚어 보강 — `aliasModelName` 을 manager 에
  import 해서 두 spot 에 적용. regression test 한 개 추가해 detail 레이아
  웃에서 status card / preset 둘 다 alias 결과를 직접 비교.

### 검증

- `pnpm test`: 1186 / 1186 passing (1185 + 신규 alias 테스트 7 + manager
  detail-alias 테스트 1 → snapshot 1 갱신).
- 런타임 sanity: `renderSessionSlot` 두 번 호출해 `processingStartFrame`
  4 프레임 차이로 stagger 시킨 결과 `dashoffset` 이 `-220` vs `-132` 로
  분리됨을 확인.
- 실기 검증 (Stream Deck 본체에 plugin link 후 OpenClaw 다중 세션 RUN
  타이밍 차로 띄워보기) 은 사용자 몫으로 남겨둠.

---
