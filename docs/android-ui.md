---
id: design.android-ui
title: Android UI Vision
description: How the aquarium-tide language lands on e-ink and tablet Android surfaces — layouts, creatures, refresh zones.
category: Design
locale: en
canonical: true
status: stable
owner: Android maintainers
reviewed: 2026-10-25
revision: 2026-10-25
source_of_truth: docs/android-ui.md
validators: [bash design/lint.sh, pnpm test:android]
---
# Android UI/UX Vision

두 디바이스에서 iOS Dashboard 와 같은 에이전트 정보를 같은 조작 모델로 시각화한다. Android tablet 은 iOS Dashboard 의 UX parity 를 목표로 하고, e-ink 는 별도 “기능 UX”가 아니라 느린 화면 갱신/저대비/작은 화면을 위한 고대비 projection 을 둔다. 빌드/기기 레퍼런스는 [android.md](android.md) 참조.

## Guided setup

First use follows Appearance → Connect → Ready on both LCD and e-ink. Use the
production renderers with an empty local habitat for appearance previews; never
inject sample sessions into `AgentStateHolder`. Back, skip and completion remain
reachable on compact screens and with the keyboard open. Completion is persisted;
legacy installations retain their settings and may opt in through Settings.

Connection reuses `BridgeAutoConnect` and `ConnectionPanel`, including host-bound
credentials, approval recovery and six-digit pairing. An ambiguous host list must
not spend a code against whichever host appeared first. Disconnected, connected
without sessions and receiving activity have distinct readiness copy. Android is
a companion: agent authorization remains on the computer running the agents.

## Session inspection

LCD and e-ink history selection is local to the current screen. On LCD, tapping
the same session again clears the filter; both history headers expose a clear action.
Native 3D creature taps use the rendered silhouette bounds, picking the nearest
visible creature when bounds overlap. Empty water retains the viewing-mode toggle.
Session-list taps provide the same inspection route, including on e-ink.
On e-ink, inspection opens a scrollable reading view; clear returns to the board.
It includes unanswered turns marked IN PROGRESS, interrupted turns, and abandoned
task summaries with their outcome labels. The normal DONE zone remains limited
to finished work.
Hardware relay focus does not retarget this history. The full contract is in
[protocol.md](protocol.md#dashboard-inspection-and-control-focus).

## Background work

Background tasks remain attached to their session and are separate from child
agents. LCD 2D and 3D use Apple's jar-buddy language: up to three clay jars
with moving lids and simmer bubbles, plus up to nine pearl moonlets for extra
tasks. A 12-second orbit passes behind and in front of its owner; a lower explicit
count finishes only the departing buddies. The exact count remains readable.
Android 3D uses actual Filament meshes with scene lighting and depth occlusion;
2D uses generated Apple Canvas paths in two passes. Dimensions and artwork are
exported by `generate-background-presentation.mjs`; the 3D mesh source and assets
are digest checked. Re-export meshes with Blender and
`assets/terrarium/export-android-background-buddies.py` after reviewing Apple changes.
Android's animation-duration setting freezes buddies on the front arc without
completion effects. Unknown telemetry retains the last known count by session
identity, never creating a completion; disconnect drops that host's roster.
Attention and CI keep priority over decorative background cues.

E-ink uses a stable count/status line in both the session column and Paper Board.
There is no background-work animation timer or scheduled completion refresh on
paper. Explicit zero reads “Background complete”; missing information adds no
line. Agent permission/CI information keeps its priority.

## Native 3D frame budget

Filament owns frame pacing; do not add another elapsed-time frame gate in the
Choreographer callback. The renderer's target and dynamic-resolution interval
must agree: up to 60 Hz normally, 30 Hz during power saving or moderate-or-higher
thermal pressure, bounded by the display refresh rate. A device that sustains
less than 80% of its 60 Hz submission budget over three seconds, after a five-second
warmup, uses the same constrained budget until resume. Thermal recovery starts a
fresh observation window. Budget changes are sampled
outside the frame hot path. Only successfully submitted frames invalidate labels.
UI text remains at display resolution; the opaque 3D surface uses mobile HDR,
MSAA and spatial upscaling with a bounded dynamic resolution. Constrained devices
omit sampled shadows while retaining direct/ambient lighting, geometry and motion.

Signed builds allow shell profiling. `Aquarium.animate`, `Aquarium.residents`
and `Aquarium.render` trace sections separate CPU work; `Aquarium.targetHz`,
`Aquarium.scalePermille` and `Aquarium.rendered` expose the active budget.
`Aquarium.buddyRigs` records the instance-pool high-water mark. Background jars,
pearls and bubbles share immutable geometry/materials, recycling hidden instances
across session identities; the owning assets are destroyed with the surface.
Use SurfaceFlinger **SurfaceView** presentation statistics for the aquarium's
actual displayed cadence. `dumpsys gfxinfo` measures the Android UI layer and
must not be reported as the native aquarium's FPS. Keep thermal status with each
measurement and record video separately, since capture adds GPU/encoder load.

## 표시 정보 (공통)

- **Agent Identity**: 에이전트 타입, 세션명, 현재 모델, 상태 (IDLE/PROCESSING/AWAITING 등)
- **Event Log**: 에이전트 활동 이벤트 요약 (tool call, model call, state change)
- **Account/Connection**: OAuth 연동 상태 (connected/disconnected), billingType, bridge connection status
- **Usage Gauges**: 5h/7d rate limit % + 리셋까지 남은 시간, tokens, cost, uptime
- **Ollama Status**: ollama 프로세스 상태 (running/stopped) + 실행 중 모델 목록
- **Creature Animation**: 도트/픽셀 아트 형태의 에이전트 캐릭터 애니메이션

Timeline 은 raw event feed 가 아니라 의미 단위 projection 이다. 실제 사용자 요청인
`chat_start` 아래에 같은 실행의 일반 툴 활동과 `chat_response` / `chat_end`를 묶는다.
툴 요약은 요청 아래에 표시하고 상세 결과는 펼쳐서 확인한다. 승인 요청, 하위 에이전트 기록,
부모 요청을 확인할 수 없는 활동은 독립 행을 유지한다. 저장된 전체 범위를 그룹화한 뒤 화면
행 수를 제한하므로 다른 세션의 로그가 많아도 요청과 응답이 분리되지 않는다. 명시된
`sessionId`나 `runId`가 다르면 같은 `taskId`여도 툴 활동은 합치지 않는다.

Android selects the most recently updated groups after chronological grouping:
50 on LCD and three below the e-ink work roster. Tool result `endedAt`, merged reply and completion
timestamps contribute to recency; equal activity timestamps preserve source
group order. E-ink shows the latest meaningful child at the group's latest
activity time, so a late tool result can supersede an older reply. Progress-only
metadata updates recency without replacing meaningful glance text. Explicit
selection and inline expansion follow the originating turn as rows move.

## E-ink (Crema/Pantone/Kobo) — shared Dashboard model, readable projection

E-ink 는 tablet/iOS 와 같은 화면 배치를 강제하지 않는다. 공통화 대상은 상태 모델, 세션 focus,
option 응답, settings 의미, topology 관계, timeline 의미다. 표현은 e-ink 에 맞는 `EinkMonitorScreen`
projection 을 사용한다.

- EPD refresh zones / debounce / full-refresh timing: ghosting, flicker, battery를 제어하기 위한 장치 로직
- grayscale/color e-ink rendering path: path 연산 실패, 16-level gray snap, color e-ink A2 partial refresh 등 실제 렌더링 제약
- 작은 화면/강제 landscape/immersive mode: Crema/Pantone 등 물리 디스플레이 한계
- 고대비 정보 배치: 투명 overlay, 작은 컬러 텍스트, 장식 배경 위 텍스트, 색상만으로 구분하는 상태 표시 금지

따라서 세션 focus, option 응답, connection/settings 의미, topology 관계는 iOS/tablet Dashboard 와 동일해야
한다. 다만 같은 정보를 같은 픽셀 위치에 놓는 것은 parity 가 아니다. e-ink 전용으로 남겨야 하는 코드는
`EinkMonitorScreen`, `EinkAquariumFrame`, `EinkRenderer`, EPD refresh helper, grayscale/color palette,
hardware rotation fallback 처럼 판독성과 물리 표시 장치에 직접 연결된 부분이다.

### Refresh-constrained projection

Android readers open one **work-and-usage dashboard**. The terrarium is an
explicit **Frame** mode. Common Dashboard state and actions feed both; neither
view invents sessions or changes the meaning of focus, inspection, usage, or
attention. Shared state labels, marks and contrast keep readers consistent with
other e-ink devices; the six-inch layout uses its own available width and height.

The compact header keeps identity, snapshot time, rotation, Settings and the
Frame toggle reachable. There is no Overview / Sessions / Usage tab row or
global page footer. Frame selection, region reading positions and provider
expansion survive rotation. These are local viewing choices, not commands to
another device.

| Mode | Portrait | Landscape |
|---|---|---|
| Dashboard (default) | Full ranked work roster above a compact usage region; usage uses two provider columns when content fits | Work roster on the left and usage on the right |
| Frame | Aquarium fills the space beneath the header and any attention | Aquarium fills the space beneath the header and any attention |

The dashboard gives work and usage separate bounded regions, visible together
in both orientations. Work includes every session in waiting, working and quiet
groups, followed by the latest finished items. It does not stop at a fixed
preview count. When either collection exceeds its region, that region scrolls
independently and shows a visible scroll affordance. Reaching the last session
keeps usage visible; expanding and scrolling usage keeps the work region
visible. Content growth never moves one region beneath the screen or lets it
paint over the other. Text grows and wraps instead of shrinking to fit.

- **Usage**: Every available provider appears with its primary windows. Extra
  windows or model-specific limits expand below that provider, in the same
  region; the disclosure names the hidden limit count and flags critical hidden
  usage. A provider's plan stays with its identity, including when it has no
  metered windows. Provider columns use measured content width and the actual
  font scale. Two columns are used only when their labels, gauges and numeric
  values fit; narrower or larger-type layouts fall back to one column. Long
  labels wrap above their gauge, and numeric columns stack when necessary. All
  scoped-limit names, percentages and reset strings remain reachable without
  opening a separate full-screen view. Claude stale values are hidden;
  Codex/GLM stale values retain the last figure with `?`, and critical usage adds
  `!`. Data changes, provider expansion, selected mode and each region's scroll
  position participate in refresh keys. MODELS/DEVICES/Topology remain in
  Settings or diagnostics.
- **Frame**: The aquarium is mounted only in Frame mode. It has no roster or
  quota panels over the water. The header toggle returns to the work dashboard;
  attention stays outside the aquarium and visible in both modes. Choosing
  Frame is explicit rather than a timed switch that could hide work while
  reading. Residents face their direction of travel through the habitat.
  Working agents turn and accelerate toward a destination, brake, then pause
  for working gestures. Quiet agents alternate slower exploration and rest;
  quiet Hermes holds its resting position. Waiting and CI waiting brake the
  resident to a stop; sleeping freezes motion. Stopping retains the last body
  direction. Names and CI companions follow the resident. A compact activity
  summary describes the visible residents; CI waiting counts as waiting.
- **Settings parity**: tablet/iOS 와 같은 Connection / Mac integrations(read-only) / Display panels / Display & sleep / About 의미를 유지한다. 기록 탐색은 화면별 로컬 선택이며, option 응답만 명시적인 세션 제어 명령을 보낸다.
- **Attention parity**: Any `awaiting_*` session can occupy the full-width
  `ATTENTION` strip beneath the chrome in its own `FULL_ONCE` zone. Render only
  the question, options and cursor supplied by the daemon. Selecting a delivered,
  actionable option focuses that session and sends `select_option` for its actual
  index. Observed sessions require the daemon's `liveAnswerable` signal before
  enabling those choices. If no options were supplied, show `Respond in your
  terminal`; if supplied choices cannot be delivered remotely, retain them as
  disabled choices with `Choose in your terminal`. Never manufacture a
  `Yes/No/Always` set.
- **Orientation**: portrait/landscape 둘 다 지원한다. rotate control 은 `Settings button` 표시 여부와 독립적으로 남겨 화면 전환을 잃지 않게 하고, Pantone/RK3566 처럼 `requestedOrientation` 을 무시하는 기기는 `USER_ROTATION` fallback 을 함께 적용한다. `Auto` 는 `ACCELEROMETER_ROTATION` 을 다시 켜 system rotation 을 복원한다. 기본값은 e-ink landscape 고정, 일반 tablet 은 Auto 다.
- **Frame habitat**: Compose `clip(RoundedCornerShape)` 둥근 모서리 (내부 테두리 없음), 수면 파도, 해초, 자갈, 거품 — 수족관 느낌
- **Multi-agent visibility**: Bridge `/health`에서 sibling state 조회, Gateway TCP probe로 OpenClaw 감지. Daemon primary는 agent list에서 제외 (coding agent 아님). OpenClaw primary는 목록에 🦞로 표시하되 terrarium octopus에서는 제외 (crayfish가 담당)
- **Crayfish 독립 상태**: sibling OpenClaw session의 state에서 ROUTING/SITTING 결정 (primary agentType 의존 제거)
- **Refresh zones**: Chrome and ordinary reading updates use A2 (200 ms);
  scroll position uses the soft A2 trigger. Mode and viewport/font-scale
  changes also update `qualityTriggerKey`: after the layout settles, one
  `requestQualityRefresh` cleans the changed region in grayscale. Repeated data
  updates or scrolling do not repeat this cleanup for the same key. Attention
  uses `FULL_ONCE` (80 ms + cursor soft refresh), and Frame uses the callback-based
  `EinkAnimatedRefreshZone`. The work-and-usage dashboard does not mount the
  terrarium view or request aquarium animation frames. Preserve the wrapper's
  `LAYER_TYPE_SOFTWARE` grayscale path and the renderer's color-capable GPU path.
  Aquarium `EinkTerrariumView.onFrameRendered` callbacks request A2 partial or
  animation-mode updates on B&W and color panels; state transitions request one
  debounced regional GC16 cleanup after 500 ms, not a full-screen flash per frame.
- **EPD vendor API**: Rockchip RK3566 (Pantone 6) — `android.os.EinkManager` system service, `setMode("2"=GC16/"12"=A2/"14"=DU)` + `sendOneFullFrame()`. Crema S 실측: IWG/Qualcomm sdm660, firmware `View.setDefaultUpdateMode()` + `invalidate()` / explicit `refreshScreen(...)`를 capability probe 후 사용한다. Onyx SDK fallback — `BaseDevice.setViewDefaultUpdateMode()`. 지원 근거 없는 `sys.eink.update` 쓰기는 제거했다. KOReader `RK35xxEPDController` 참고
- **E-ink grayscale**: 네이티브 16-level 그레이, `DitherEngine.snapToNearestGray()` (에러 디퓨전 없음). 수조 내부 테두리 없음 — Compose `clip(RoundedCornerShape)` 만 사용. 크리처 부위별 그레이: body(0x44), limb/claw(0x33), starburst(0x99), sleeping=dimmed. 환경: sand(0xCC), fish body(0x55)+stripe(0xBB), rock outline(0x22), seaweed 2px. Frame의 세션 배치는 아래의 readable aquarium population 정책을 따른다.
- **Session overflow**: 기본 작업 영역에 전체 정렬된 세션 목록을 유지한다. 영역 안에서 마지막 세션까지 스크롤할 때에도 사용량 영역은 보이며, 사용량을 펼쳐도 작업 영역은 밀려나지 않는다. 중복 프로젝트 이름의 `#N`은 스크롤 재구성 중에도 유지한다.
- **Readable aquarium population**: Frame uses the shared native priority and maximum of eight residents: focus, attention, CI waiting/failure, then working sessions. The complete roster stays on the dashboard, and overflow is explicit, such as `8 of 24`. Resident count never turns the scene into progressively smaller marks.
- **Habitat travel and behavior**: `EinkResidentMotion` keeps each session's
  position, velocity, destination, orientation and behavior between frames.
  Deterministic destinations span the habitat. Steering and neighbor avoidance
  leave room to pass, with viewport bounds reserving room for bodies and labels.
  Claude and OpenClaw move through lower ground depths; other species use the
  water. Working alternates travel and task gestures at a destination; idle
  alternates slower exploration and rest. Waiting and CI waiting stop travel,
  sleeping freezes motion, and quiet Hermes holds its resting position. A fixed
  integration step keeps the path independent of presentation cadence. State
  changes preserve the current location instead of restarting a route.
- **Direction and transitions**: Body direction and gaze follow steering at a
  bounded turning rate. A sharp reversal brakes before turning and accelerating;
  tiny positional corrections do not flip the resident. On stopping, retain the
  last direction. Movement strength eases with actual speed, so walking and
  swimming settle into rest. Work gestures and their dwell period begin after
  arrival braking settles. Sleep deliberately freezes location and gait at once;
  viewport or roster changes still resolve static geometry on the first frame.
- **Visible activity and names**: Gait advances with meaningful distance
  travelled; a separate work phase drives gestures during work pauses. Claude's
  canonical feet and hands, OpenClaw's claws, and Hermes's generated tail
  articulate while retaining the identifying geometry. Directional body
  projection preserves readable terminal prompts and other identifying glyphs.
  Small contact shadows move beneath ground residents, and water wakes follow
  actual velocity. Names stay upright as text with a light halo and no
  rectangular backing. Existing name priority and collision resolution remain,
  and CI companions follow the actual resident position.
- **Static 3D habitat in Frame mode**: LCD와 실제 전자책에서 e-ink Frame 모드를 선택하면 Blender에서 제작한 정적인 배경을 캐시해 GPU에서 투명 크리처 비트맵과 별도로 합성한다. 공식 에이전트 실루엣·눈의 빈 공간·이름표와 물고기는 런타임에서 그리며, 크리처에는 좌상단 조명의 명암과 안티앨리어싱을 적용한다. 흑백 변환은 배경 로드 때 한 번만 수행하며, 화면 회전 시 배경의 비율을 유지해 중앙 crop한다. 흑백 EPD 배경은 16단계의 밝은 명암으로 한 번 변환해 에이전트 대비를 확보하며, 시간에 따라 디더링하지 않는다. 가장자리 수초와 달팽이만 작은 범위에서 움직이고, 기포는 LCD/컬러에만 표시한다. 원본 및 재생성: `assets/terrarium/`.
- **Animation pacing**: LCD에서 e-ink UI를 선택해도 실제 패널을 별도로 감지해 GPU/vsync 경로를 사용한다(기기 주사율 상한). 실제 EPD는 수조 view에 최대 10Hz A2 부분 갱신을 요청한다. 프레임 간격에 렌더 시간을 더하지 않고 늦은 프레임을 건너뛰며, 애니메이션 중 전체 픽셀의 회색 재변환을 생략한다. 400ms는 이동 속도의 기준 단위일 뿐 화면 갱신 간격이 아니다. 패널의 실제 응답률은 vendor/파형에 달려 있다.
- **Fish motion**: `EinkFishSchool`은 힘 기반 boids 대신 넓은 순환 경로를 따라 두 무리가 유영한다. 개체별 앞뒤 간격과 수심 간격을 유지하고, 선회는 화면 평면 회전이 아니라 옆모습의 폭이 줄었다 반대 방향으로 향하는 yaw 투영으로 표현한다. 몸체는 유선형이고 꼬리는 연속 위상으로 움직이며, 원경의 물고기는 에이전트 뒤로 가려진다. STREAMING/HOVERING은 같은 경로의 속도만 부드럽게 바꾸며, 3.125ms simulation tick과 Double 위상은 100ms/400ms 화면 갱신 및 반복 순환에서 경로 연속성을 유지한다.
- **Color e-ink (Kaleido 3)**: MOAAN Pantone 6 등 컬러 e-ink 지원. `DeviceProfile.isColorEink`(→ `einkColorEnabled`) + `einkPick(gray, color)`. 테라리움은 브라우저 동영상 재생 경로에 가깝게 **10fps fast partial refresh(A2/animation mode)** 를 사용한다. 논리 애니메이션 시간은 B&W e-ink 기준 400ms cadence로 스케일링해 프레임 수만 늘리고 크리처/물고기 속도는 유지한다. 상태 변경 시에는 중복 full flash 대신 regional GC16 refresh를 요청하고, 프레임 렌더에서는 `snapToNearestGray` 를 스킵해 RGB를 보존한다. UI 텍스트(게이지/타임라인/라벨)는 컬러 적용 (갱신 빈도 낮음). 컬러 팔레트: octopus terracotta `#C07058`, crayfish red `#CC3333`, tetra blue `#3366AA`+cyan `#55CCEE`, seaweed green `#336633`, sand `#D4B896`, water `#C8DDE8`. `manufacturer="rockchip"` (not "moaan"), `model="Pantone6"`

## Tablet (Lenovo) Monitor 레이아웃 — 수족관 + HUD 오버레이

- 전체 화면: 컬러 수족관 배경 (최대 60fps 목표, 발열·절전 시 30fps 목표), 빈 물 영역 탭으로 HUD 숨김/복원
- 반투명 HUD 패널로 iOS Dashboard 와 동일한 정보 오버레이
- 좌측: AgentDeck 로고 + primary/sibling session list. Row tap 은 해당 화면의 타임라인만 필터링하며, 다른 기기의 제어 대상을 바꾸지 않는다.
- 우측: topology rail — upstream providers → AgentDeck hub → downstream devices (`moduleHealth`: Stream Deck, D200H, Pixoo, ESP32, Android/e-ink)
- 상단 중앙: awaiting session Attention theater. 응답 전에 해당 session 을 focus 하고 `select_option` 을 보낸다.
- 하단: Timeline strip (이벤트 로그)
- Settings: iOS 와 같은 Connection / Mac integrations(read-only) / Display panels / About / Display & sleep 구조. Display panels 는 session list, topology rail, timeline, settings button 표시를 제어한다.
- Orientation: 일반 tablet 은 Auto 를 기본으로 하되 portrait/landscape pinning 을 Settings 에서 제공하고, 수조 화면의 rotate control 은 Settings button 표시 여부와 독립적으로 남긴다. 시스템 회전 잠금이 켜져 있어도 AgentDeck 내부에서 방향을 전환할 수 있어야 한다.

## Creature Design — 도트 아트 통일

- **Canonical agent silhouettes**: Android e-ink draws the canonical `CreatureGeometry` SVG paths with `Canvas.drawPath`, including transparent eye cutouts, instead of approximating the agents as pixel grids or oval icons. The same brand assets feed the native aquarium. Hermes uses its shared mermaid geometry. The e-ink renderer applies grayscale or color shading and the scene placement policy above; ESP32/TUI keep their panel-specific pixel glyphs. Pixoo keeps sand at px54 with a 3px gap to the HUD at px57.
- **CrayfishCreature** (OpenClaw): SVG Path 기반 front-facing 렌더링, red/teal gradient, `PathParser` + `withTransform` pivot rotation. SITTING: heartbeat glow (4초 주기 더블펄스), ROUTING: full animation (claw clap, signal waves, eye flash, glow pulse), SICK: 탈색+기울기+늘어진 집게+흐린 눈 (gateway 에러 시). `currentPosition()` + `isRouting()` — DataParticleSystem에 위치/상태 제공
- **Neon Tetra**: 14마리 2개 무리(schoolId 0/1, 7마리씩), Lissajous 경로 school centers로 만남/흩어짐 반복. Boids: cohesion/alignment=같은 무리만, separation=전체. `SCHOOL_ATTRACTOR_WEIGHT=0.4` (먹이 있으면 무효). `TETRA_SWIM` 경계 `0.03~0.92 X`, `0.08~0.68 Y`. E-ink: 12마리 2무리(6+6), size `0.013f`, `einkPrevFishX` heading 추적, STREAMING시 에이전트 인력 30% + 데이터 파티클 4개. **가재 반응**: ROUTING 가재도 food crumb 산란 + school center 30% 인력 → 옥토퍼스 없을 때(OpenClaw primary) 가재가 물고기 유도
- 독립 애니메이션 가능한 부위별 셀 타입 분리 (눈, 팔/집게, 다리 등)
- 상태 애니메이션: 셀 좌표 오프셋, 색상 lerp, pivot 기반 회전 (SVG transform 아님)

## Launcher app

`android/` — Jetpack Compose, minSdk 29, CATEGORY_HOME, NSD mDNS discovery, operator approval and six-digit pairing (no QR scanner), e-ink detection (Crema/Onyx/Kobo).

**Screens**: onboarding until pairing completes, then one dashboard shell — `EinkMonitorScreen` with the work-and-usage dashboard and explicit Frame mode on e-ink devices (or when the Paper dashboard type is chosen), `TabletDashboard` (terrarium background + HUD overlay panels, connection overlay when disconnected) otherwise. Settings opens as a dialog from the dashboard. MonitorService: CPU wake lock + system stay-on + screen wake on state change (e-ink).

The former Deck tab (encoder strip + 2×4 button grid mirroring the daemon's `encoder_state` / `button_state`) is gone: the app has ignored both frames since the tab was removed, and the Node daemon stopped producing them in #273 phase 0.

**Voice**: Android AudioRecord → WAV → HTTP POST `/voice/transcribe` → 데몬이 번들 헬퍼(Apple 온디바이스 Speech)로 전사.

**Utility commands**: the app does not send `utility`. The command is served by the Swift daemon and by managed session bridges only — see [protocol.md](protocol.md).

**Slot map**: Plugin reports SD+ profile layout → Bridge caches → Android mirrors dynamically.
