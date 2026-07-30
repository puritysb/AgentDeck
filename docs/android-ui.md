---
id: design.android-ui
title: Android UI Vision
description: How the aquarium-tide language lands on e-ink and tablet Android surfaces — layouts, creatures, refresh zones.
category: Design
locale: en
canonical: true
status: stable
owner: Android maintainers
reviewed: 2026-07-21
revision: 2026-07-21
source_of_truth: docs/android-ui.md
validators: [bash design/lint.sh, pnpm test:android]
---
# Android UI/UX Vision

두 디바이스에서 iOS Dashboard 와 같은 에이전트 정보를 같은 조작 모델로 시각화한다. Android tablet 은 iOS Dashboard 의 UX parity 를 목표로 하고, e-ink 는 별도 “기능 UX”가 아니라 느린 화면 갱신/저대비/작은 화면을 위한 고대비 projection 을 둔다. 빌드/기기 레퍼런스는 [android.md](android.md) 참조.

## 표시 정보 (공통)

- **Agent Identity**: 에이전트 타입, 세션명, 현재 모델, 상태 (IDLE/PROCESSING/AWAITING 등)
- **Event Log**: 에이전트 활동 이벤트 요약 (tool call, model call, state change)
- **Account/Connection**: OAuth 연동 상태 (connected/disconnected), billingType, bridge connection status
- **Usage Gauges**: 5h/7d rate limit % + 리셋까지 남은 시간, tokens, cost, uptime
- **Ollama Status**: ollama 프로세스 상태 (running/stopped) + 실행 중 모델 목록
- **Creature Animation**: 도트/픽셀 아트 형태의 에이전트 캐릭터 애니메이션

Timeline 은 raw event feed 가 아니라 의미 단위 projection 이다. `chat_start` 는 같은
session/project 의 completion 이 생기기 전까지만 진행 중 row 로 남고, completion 이후에는
`chat_response` / `chat_end` / `eval_result` 가 요약된 단위 session row 를 대표한다. Android tablet 과
e-ink 는 `TimelineDisplay.kt` 의 같은 projection 을 사용하며, 그룹화는 `runId → sessionId →
projectName+agentType` context 가 같을 때만 허용한다.

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

아래 3-section layout 이 e-ink 의 기본 projection 이다. 신규 구현은 tablet `MonitorScreen` overlay 를
e-ink 에 그대로 얹지 말고, 이 projection 에 공통 Dashboard state/action 을 연결한다. 핵심 화면은
Sessions / Terrarium / Timeline 이고, rate limit 은 데이터가 실제로 제공될 때만 수조 corner card 로 격하한다.

Landscape: 상단 chrome + `Sessions | Terrarium`, 하단 text Timeline

```
[AgentDeck icon] AgentDeck · :9120       S:4   rotate  settings
──────────────────────────────────────────────────────────────
[Sessions]                 ∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿
  agentdeck #1             🐙  🦞  cloud
    opus-4 · ● PROC        sand / fish / state labels
  agentdeck #2                                           LIMITS
    sonnet · ○ IDLE                                      5h ███░
  codex-main
    gpt-5 · ● PROC
──────────────────────────────────────────────────────────────
TIMELINE
10:32 [agentdeck] Claude  [T ] Read file_path.ts
10:33 [apme-tuner] Codex  [M ] Model call gpt-5
10:33 [agentdeck] Claude  [==] TASK Update dashboard
```

- Chrome: AgentDeck icon + wordmark + `:9120` + session count + rotate + settings. Rotate control 은 Settings button 표시 여부와 독립적으로 남긴다.
- Landscape: 상단 row 는 Sessions(약 36%) | Terrarium(약 64%), 하단은 text Timeline(약 36%). Timeline 은 macOS/iOS/Android tablet 과 같은 task/event text projection 이며 vertical lane / chart timeline 을 쓰지 않는다.
- Portrait: Chrome 아래 `Sessions / Terrarium / Timeline` 3단 full-width stack. Terrarium 은 세로로 길게 늘리지 않고 항상 가로 수조 장면으로 유지한다.
- **Limits corner card**: Claude 5h/7d usage 값이 신선하게 들어온 경우에만 Terrarium 우하단 작은 card 로 표시한다. 값이 없거나 stale 이면 섹션 자체를 숨긴다. MODELS/DEVICES/Topology 는 primary e-ink 화면에서 노출하지 않고 Settings/diagnostic 경로로 둔다.
- **Settings parity**: tablet/iOS 와 같은 Connection / Mac integrations(read-only) / Display panels / Display & sleep / About 의미를 유지한다. 세션 focus 와 option 응답은 tablet 과 동일하게 bridge 명령을 보낸다.
- **Attention parity**: 어떤 세션이든 `awaiting_*` 상태가 되면 chrome 아래 full-width `ATTENTION` strip 을 별도 `FULL_ONCE` zone 으로 띄운다. focused session 이면 실제 question/options/cursor 를 표시하고, 다른 session 이면 iOS/tablet 과 동일하게 focus 후 `select_option` 을 보내며 parser 가 옵션을 못 준 경우 `Yes/No/Always` fallback 을 제공한다.
- **Orientation**: portrait/landscape 둘 다 지원한다. rotate control 은 `Settings button` 표시 여부와 독립적으로 남겨 화면 전환을 잃지 않게 하고, Pantone/RK3566 처럼 `requestedOrientation` 을 무시하는 기기는 `USER_ROTATION` fallback 을 함께 적용한다. `Auto` 는 `ACCELEROMETER_ROTATION` 을 다시 켜 system rotation 을 복원한다. 기본값은 e-ink landscape 고정, 일반 tablet 은 Auto 다.
- 수조: Compose `clip(RoundedCornerShape)` 둥근 모서리 (내부 테두리 없음), 수면 파도, 해초, 자갈, 거품 — 수족관 느낌
- **Multi-agent visibility**: Bridge `/health`에서 sibling state 조회, Gateway TCP probe로 OpenClaw 감지. Daemon primary는 agent list에서 제외 (coding agent 아님). OpenClaw primary는 목록에 🦞로 표시하되 terrarium octopus에서는 제외 (crayfish가 담당)
- **Crayfish 독립 상태**: sibling OpenClaw session의 state에서 ROUTING/SITTING 결정 (primary agentType 의존 제거)
- **Refresh zones**: Chrome/Sessions A2(200ms), Attention `FULL_ONCE`(80ms + cursor soft refresh), Terrarium `EinkAnimatedRefreshZone`(callback 기반), Timeline A2(300ms). `LAYER_TYPE_SOFTWARE` on wrapper FrameLayout for B&W EPD grayscale, GPU layer for color e-ink. 수조 애니메이션: `EinkTerrariumView.onFrameRendered` 콜백 → B&W animation frame=GC16 partial(플래시 없음), color animation frame=A2/animation mode, state transition=FULL/normal refresh(고스팅 클리어)
- **EPD vendor API**: Rockchip RK3566 (Crema S) — `android.os.EinkManager` system service, `setMode("2"=GC16/"12"=A2/"14"=DU)` + `sendOneFullFrame()`. Onyx — `BaseDevice.setViewDefaultUpdateMode()`. KOReader `RK35xxEPDController` 참고
- **E-ink grayscale**: 네이티브 16-level 그레이, `DitherEngine.snapToNearestGray()` (에러 디퓨전 없음). 수조 내부 테두리 없음 — Compose `clip(RoundedCornerShape)` 만 사용. 크리처 부위별 그레이: body(0x44), limb/claw(0x33), starburst(0x99), sleeping=dimmed. 환경: sand(0xCC), fish body(0x55)+stripe(0xBB), rock outline(0x22), seaweed 2px. 멀티세션 Y stagger: `standingOffset = (centerXFraction - 0.38) * 0.10`
- **Color e-ink (Kaleido 3)**: MOAAN Pantone 6 등 컬러 e-ink 지원. `DeviceProfile.isColorEink`(→ `einkColorEnabled`) + `einkPick(gray, color)`. 테라리움은 브라우저 동영상 재생 경로에 가깝게 **10fps fast partial refresh(A2/animation mode)** 를 사용한다. 논리 애니메이션 시간은 B&W e-ink 기준 400ms cadence로 스케일링해 프레임 수만 늘리고 크리처/물고기 속도는 유지한다. 상태 변경 시에는 full/normal refresh로 고스팅을 정리하고, 프레임 렌더에서는 `snapToNearestGray` 를 스킵해 RGB를 보존한다. UI 텍스트(게이지/타임라인/라벨)는 컬러 적용 (갱신 빈도 낮음). 컬러 팔레트: octopus terracotta `#C07058`, crayfish red `#CC3333`, tetra blue `#3366AA`+cyan `#55CCEE`, seaweed green `#336633`, sand `#D4B896`, water `#C8DDE8`. `manufacturer="rockchip"` (not "moaan"), `model="Pantone6"`

## Tablet (Lenovo) Monitor 레이아웃 — 수족관 + HUD 오버레이

- 전체 화면: 컬러 수족관 배경 (60fps 애니메이션), 빈 물 영역 탭으로 HUD 숨김/복원
- 반투명 HUD 패널로 iOS Dashboard 와 동일한 정보 오버레이
- 좌측: AgentDeck 로고 + primary/sibling session list. Row tap 은 `focus_session` 을 보낸다.
- 우측: topology rail — upstream providers → AgentDeck hub → downstream devices (`moduleHealth`: Stream Deck, D200H, Pixoo, ESP32, Android/e-ink)
- 상단 중앙: awaiting session Attention theater. 응답 전에 해당 session 을 focus 하고 `select_option` 을 보낸다.
- 하단: Timeline strip (이벤트 로그)
- Settings: iOS 와 같은 Connection / Mac integrations(read-only) / Display panels / About / Display & sleep 구조. Display panels 는 session list, topology rail, timeline, settings button 표시를 제어한다.
- Orientation: 일반 tablet 은 Auto 를 기본으로 하되 portrait/landscape pinning 을 Settings 에서 제공하고, 수조 화면의 rotate control 은 Settings button 표시 여부와 독립적으로 남긴다. 시스템 회전 잠금이 켜져 있어도 AgentDeck 내부에서 방향을 전환할 수 있어야 한다.

## Creature Design — 도트 아트 통일

- **OctopusCreature** (Claude Code): SVG path (claudecode.svg Antigravity, viewBox 24×24), terracotta, EvenOdd fill rule (눈은 투명 cutout). Android: Compose `PathParser` + `drawPath`. Apple: `CGPath` + `FillStyle(eoFill: true)`. **E-ink: `drawRect` 12×8 픽셀 그리드** (`canvas.drawPath()` e-ink Canvas 미지원 — silent fail). ESP32/TUI: 12×8/14×5 픽셀 그리드 유지. **E-ink 렌더링 제약**: `canvas.drawPath()`, `Path.op()` 등 복잡 Path 연산은 e-ink Canvas에서 silent fail → `drawRect`/`drawCircle`/`drawOval`/`drawLine` 기본 프리미티브만 사용. E-ink Cloud(Codex)는 단일 `drawOval` pill 실루엣 (이전 6-lobe clover는 각 원 개별 stroke로 seam 노출 → 단일 타원으로 대체), Crayfish도 `drawOval`+`drawLine` 조합. E-ink Cloud/OpenCode Y는 state 기반: WORKING만 layout swim slot 사용, FLOATING/SLEEPING은 지면 근처(Cloud ~0.56, OpenCode ~0.60)로 안착 — idle 세션이 상층에 떠있지 않도록. Standing 상태: per-instance `standingJitter` + X-correlated depth offset로 자연스러운 멀티세션 배치. **크리처 타입별 배치 분리**: Octopus homeX `0.20-0.50` (좌측), Cloud `0.30-0.55` (중앙), OpenCode `0.45-0.68` (우측), Crayfish `0.75-0.78` (최우측). Idle Y 지면 근접: Oct 0.62, Cloud 0.60, OC 0.61, Crayfish 0.64 (sand 0.65 바로 위). Swim Y 분리: Cloud 상층(0.05-0.25), OpenCode 중상층(0.25-0.50), Octopus 중층 `0.18~0.55 X`, `0.15~0.55 Y`. Pixoo: sand px54 기준 배치, HUD(px57)와 3px gap
- **CrayfishCreature** (OpenClaw): SVG Path 기반 front-facing 렌더링, red/teal gradient, `PathParser` + `withTransform` pivot rotation. SITTING: heartbeat glow (4초 주기 더블펄스), ROUTING: full animation (claw clap, signal waves, eye flash, glow pulse), SICK: 탈색+기울기+늘어진 집게+흐린 눈 (gateway 에러 시). `currentPosition()` + `isRouting()` — DataParticleSystem에 위치/상태 제공
- **Neon Tetra**: 14마리 2개 무리(schoolId 0/1, 7마리씩), Lissajous 경로 school centers로 만남/흩어짐 반복. Boids: cohesion/alignment=같은 무리만, separation=전체. `SCHOOL_ATTRACTOR_WEIGHT=0.4` (먹이 있으면 무효). `TETRA_SWIM` 경계 `0.03~0.92 X`, `0.08~0.68 Y`. E-ink: 12마리 2무리(6+6), size `0.013f`, `einkPrevFishX` heading 추적, STREAMING시 에이전트 인력 30% + 데이터 파티클 4개. **가재 반응**: ROUTING 가재도 food crumb 산란 + school center 30% 인력 → 옥토퍼스 없을 때(OpenClaw primary) 가재가 물고기 유도
- 독립 애니메이션 가능한 부위별 셀 타입 분리 (눈, 팔/집게, 다리 등)
- 상태 애니메이션: 셀 좌표 오프셋, 색상 lerp, pivot 기반 회전 (SVG transform 아님)

## Launcher app

`android/` — Jetpack Compose, minSdk 29, CATEGORY_HOME, NSD mDNS discovery, QR pairing (CameraX + ML Kit), e-ink detection (Crema/Onyx/Kobo).

**3-tab nav**: Dashboard (terrarium bg + HUD overlay panels, connection overlay when disconnected) / Deck (encoder strip + 2×4 button grid + context area) / Settings. MonitorService: CPU wake lock + system stay-on + screen wake on state change (e-ink).

**Deck encoder strip**: 4-panel LCD mirroring (Utility/Action/Session/Voice), touch gestures (swipe=rotate, tap=push, long-press=record).

**Deck button grid**: Bridge `button_state` 프로토콜 우선, 로컬 fallback. CompactStatusBar(36dp) 상단 + 직사각형 버튼(80dp) + 넓은 ContextArea. 터치 피드백(scale 0.95+alpha 0.85), AWAITING시 전체 옵션 리스트 항상 표시, PROCESSING시 LinearProgressIndicator, IDLE시 suggestedPrompt AssistChip.

**Voice**: Android AudioRecord → WAV → HTTP POST `/voice/transcribe` → whisper.

**Utility proxy**: `bridge/src/utility-proxy.ts` — osascript macOS volume/brightness/media control via Android remote.

**Slot map**: Plugin reports SD+ profile layout → Bridge caches → Android mirrors dynamically.
