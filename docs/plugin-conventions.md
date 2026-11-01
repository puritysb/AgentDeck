---
id: spec.plugin-conventions
title: Plugin Conventions
description: Stream Deck+ encoder LCD, button rendering, OC Timeline, and D200H plugin conventions.
category: Specs
locale: en
canonical: true
status: stable
owner: Plugin maintainers
reviewed: 2026-07-18
revision: 2026-07-18
source_of_truth: docs/plugin-conventions.md
validators: [node scripts/build-design-system-viewer.mjs --check]
---

# Plugin Conventions

Stream Deck+ plugin internals — encoder LCD design, button rendering, OC Timeline panel, and cross-cutting conventions.

## Core conventions

- **Action ID pattern**: All SD actions store string IDs and use `getActionById()` — never store action object references
- **Plugin UUID**: `bound.serendipity.agentdeck` (확정 — 배포 후 변경 불가)
- **Package scope**: `@agentdeck/*` (shared, bridge, plugin, hooks, setup)
- **User data dir**: `~/.agentdeck/` — `daemon.json` (daemon port discovery), `sessions.json` (session registry), `auth-token`, `settings.json`, `timeline.json`
- **npm packages**: `@agentdeck/shared`, `@agentdeck/bridge`, `@agentdeck/setup` — public npm packages (MIT license)

## Setup-required UI

Plugin detects `agentdeck` not installed → INSTALL button → `npx @agentdeck/setup` via iTerm.

## Hook format (CRITICAL)

Claude Code v2.1+ requires 3-level nesting: `{ matcher: "", hooks: [{ type: "command", command: "..." }] }`. Old flat format `{ type, command }` silently fails. `hooks/src/install.ts` exports pure logic (`applyHooks`, `removeHooks`, `migrateHooks`) + filesystem wrappers (`installHooks`, `uninstallHooks`, `migrateHooksIfNeeded`). Bridge imports `migrateHooksIfNeeded` from `@agentdeck/hooks` (no duplication). Hook scripts use `|| true` to avoid blocking Claude when bridge is down.

## Version compatibility check

Daemon-first 사용자는 `agentdeck diag agents [--json]`에서 설치된 Claude
Code/Codex/OpenCode 버전과 `bridge/package.json`의 호환 범위를 확인한다. 이
진단은 PTY나 daemon을 시작하지 않으며 실패해도 agent 실행을 막지 않는다.
Deprecated `agentdeck claude`는 호환 기간 동안 기존 npm registry 조회와
`~/.agentdeck/compatibility.json` 1시간 throttle을 유지하지만, 그것은 legacy
wrapper 전용 경로이고 배포 manifest가 아니다. `--no-update-check` 역시 그
wrapper 조회만 비활성화한다. 제거 추적은 #273이 정본이다.

## Agent state detection

- **Shift+Tab** (`\x1b[Z`) for Claude Code mode switching (100ms debounce)
- **BillingType detection**: PTY `model_info` parser event의 `plan` 필드로 subscription/api/unknown 판별. API 사용자는 OAuth fetch 스킵 + session 페이지만 표시
- **Effort level detection**: PTY `/model` UI에서 `(high|medium|low) effort` 패턴 파싱. Levels: high/medium(default)/low. `"medium"`은 기본값이므로 UI 표시에서 제외 (high/low만 모델명 옆에 표시). Parser→SM→WS→Plugin/Android 전체 파이프라인

## Encoder LCD design

모든 인코더 LCD는 SVG pixmap 렌더링 (`encoder-layout.json` 공용). 배경 `#0f172a`, 14px 가운데 정렬 헤더, icon+value 가운데 그룹, 2px accent bar 패턴 통일. Renderer는 `plugin/src/renderers/{name}-renderer.ts` 순수 함수로 분리. Volume 다이얼(E1)은 clean 영문 title + emoji icon + value 구조를 따른다.

### Encoder takeover race guard

`takeoverGeneration` counter in `plugin.ts` — exit/enter `.then()` 콜백이 실행 시점에 이미 새 전환이 발생했으면 스킵. PROCESSING→PERMISSION 빠른 전환 시 exit 콜백이 enter 이후 layout을 덮어쓰는 레이스 방지.

## 타임라인 영속성 (데몬 소유)

**타임라인 영속성은 데몬이 소유한다**: `BridgeTimelineStore.enablePersistence()`가
`~/.agentdeck/timeline.json`을 원자적으로(tmp+rename) 기록하고 기동 시 복원한다.
Swift 데몬은 자기 컨테이너에 같은 형식(평면 JSON 배열)으로 기록하므로 두 구현이
서로의 파일에서 이어받을 수 있다. 재연결 시 `events.history` RPC로 오프라인 이벤트를
복구한다.

이 패널을 인코더에 그리던 시절과 플러그인이 유일한 기록자였던 경위는
[Retired and Experimental Surfaces](retired-surfaces.md)에 있다.

### Gateway 어댑터가 단일 source

`bridge/src/adapters/openclaw.ts`가 RPC 이벤트(`chat`/`tool.*`/`error`)를 직접 timeline
entry로 변환한다. 과거 `log-stream.ts`의 `openclaw logs --follow --json` 휴리스틱 파싱
경로는 중복/오분류(`memory|recall|search` / `tool|exec|execute|command` 광범위 regex가
무관 로그를 fake event로 합성)를 일으켜 retire 됐다(커밋 `8c3a4278`). `BridgeLogStream`은
호환을 위해 no-op stub만 남아 있다.

### Bridge→Android relay

`shared/src/timeline.ts`에 `TimelineEntry` 타입 + `parseLogLine()`(이제 `chat_message` / `error` / cron 요약 같은 **구조화된** 패턴만 인식; 휴리스틱 word-match는 제거됨) 공유. Bridge OpenClaw 모드에서 `BridgeTimelineStore` + Gateway 어댑터 → `timeline_event`/`timeline_history` BridgeEvent로 WS broadcast. Adapter가 chat tracking (prompt/duration/tools) → rich `chat_start`/`chat_end`/`tool_request`/`chat_response` 이벤트 생성. Android `StateTimelineGenerator`는 bridge timeline 수신 시 로컬 생성 억제 (`receivingBridgeTimeline` 플래그).

### Timeline enrichment pipeline

1. Gateway `chat` delta에서 `message.content[].text` 추출 (`extractMessageText()`) → `accumulatedResponse` 축적
2. 20~200자 축적 시 `extractTopicHint()` → `chat_start` 업데이트 (프롬프트 없는 cron/웹 작업용)
3. Final에서 `chat_response` (응답 전문) + `chat_end` (도구/시간 요약) 생성
4. async `summarizeResponse()` → on-device Foundation Models → MLX qwen (port 8800, `/no_think`) → 한국어 1줄 요약으로 `chat_end` enrichment (Ollama 폴백은 2026-08-22 제거 — 구형 `qwen2.5:7b` 고정핀이었다)

Bridge(daemon)에서만 요약 수행 — plugin은 daemon 경유 단일 경로. LLM 실패 시 60s TTL 후 재시도 (영구 disable 방지). 플러그인은 더 이상 `timeline_event`/`timeline_history`를 구독하지 않는다(렌더 대상이 없음) — 두 이벤트는 `FORWARDED_EVENTS`에서 빠졌다.

**Claude Code LLM 요약**: OpenClaw과 동일하게 `Stop` hook에서 `summarizeResponse()` → `upsertEntry()`로 chat_end async enrichment. `extractTopicHint()` 개선 — code fence 내부 스킵, markdown decorator 제거.

**Detail 클리닝**: `shared/src/timeline.ts`의 `cleanDetailText()` — markdown artifact(bold/heading/fence/link), JSON blob(connectionId 등 시스템 JSON 필터, error 추출), blank line 축소. OpenClaw adapter + Claude Code bridge에서 detail 저장 전 적용.

**parseLogLine 필터 개선** (역사적): broad 키워드 필터(`/whatsapp/i`, `/WebSocket error/i`, `/network_error/i`) → subsystem/module 기반 필터(`isChannelInfra` 플래그)로 전환. WhatsApp API 작업 시 tool/error 로그가 필터되는 false-positive 방지. `isChannelInfra` 분기는 `parseLogLine`에 남아 있지만, 휴리스틱 word-match로 fake `tool_exec`/`memory_recall`을 합성하던 코드는 `8c3a4278`에서 제거됐다.

**Store-level repetitive dedup**: `isRepetitiveEntry()` (shared) — `extractSemanticCore()` (chat_end: 첫 ` · ` 이전) + `extractKeywords()` keyword bag 유사도 (60% overlap threshold). 일반 엔트리 1시간 윈도우, `automated: true` 엔트리 8시간 윈도우 (content 비교 없이 automated끼리 즉시 중복 판정). 반복 시 `repeatCount` 증가 + paired chat_start도 repetitive 검증 후 제거. `deduplicateEntry()` (shared) — 텍스트 정제 → exact dedup(5s) → semantic dedup 순서, Bridge + Plugin store 공용.

**Automated tagging**: `TimelineEntry.automated?: boolean` — adapter에서 `!lastPrompt` (cron/web/channel 발 채팅)일 때 `true` 태깅. chat_start/chat_end/aborted/upsert 모두 전파. Gateway 프로토콜에 `trigger` 필드 없어 `lastPrompt` null 여부가 유일한 신호.

**텍스트 정제**: `cleanRawText()` (inline **bold**/heading/link/backtick strip), `cleanNopMarkers()` (NOP/NOOP 제거). Store 입구에서 raw/detail 양쪽 일괄 적용.

**폴백 라벨 개선**: cron/web 시작 `'Prompt sent'` → `'자동 작업'`, LLM 실패 시 `'Completed'` → `extractTopicHint(response)` 폴백 (응답 첫줄 topic 사용).

**mergeHistory dedup**: `mergeHistory()`(bridge 재연결 시 `timeline_history` 수신)에 `deduplicateEntry()` 적용 — 기존 exact `ts:type:raw` 매칭만으로는 semantic dedup 우회됨. 플러그인 사본이 삭제된 뒤로는 데몬 측 `BridgeTimelineStore`에만 해당한다.

**parseLogLine cron 요약**: cron list 테이블 행 (UUID 패턴)을 감지, error 상태만 `"Cron error: {name}"` 한 줄로 요약 표시 (ok/skipped는 스킵). `{"event":...}` JSON blob, 5자 미만 fragment도 필터.

### Android timeline UI

`TimelineStore.kt` — `GroupedEntry` + `groupConsecutive()` (plugin 로직 포팅, 60s/10s 윈도우). `TimelineEntry.status` 필드 추가. `TimelineStrip.kt` — two-pane Logbook (65% compact log + 35% detail panel), `typeIcon()` unicode 기호 (▶/■/✓/✗/⚠/◆), status-aware tool_request 아이콘. `EinkEventLog.kt` — 14개 표시 (8→14), `typeIcon()`, grouping, detail 2줄 지원.

### Timeline `detail` 필드

`TimelineEntry.detail?: string` (shared→plugin→android 관통). **Source-rich, Client-truncate 원칙**: raw 최대 500자, detail 최대 1000자로 source에서 넉넉히 전달. 각 클라이언트가 자체 truncation. Tablet `TimelineStrip`: detail 있으면 9sp dimmed 2nd line.

## D200H HID module

Ulanzi D200H communicates via **stock HID protocol** (VID `0x2207`/PID `0x0019`, same as D200). No ADB, no firmware modification, no on-device agent. 1024-byte fixed packets (header `0x7C7C` + cmd + len + payload), ZIP chunking for `SET_BUTTONS`. Device boots into HID mode after 4s. D200H returns `DeviceType:"D200"` — protocol-compatible with D200 community libraries (`strmdck`).

**Session icon invariant**: Session controls show AgentDeck's terrarium creatures, not provider/company logos. Stream Deck/Stream Deck+ SVG slots and D200H Swift PNG tiles render the same reduced creature language: Claude robot, Codex cloud prompt, OpenClaw crayfish, OpenCode nested square. Provider logos stay in brand/settings contexts only.

**Primary path: Ulanzi Studio plugin.** The D200H needs the Mac **Ulanzi Studio** app to render reliably, so the official Ulanzi Studio plugin (`plugin-ulanzi/`, registers over WS as `ulanzi-plugin`) is the **only** supported way to drive the device. It shares the `@agentdeck/shared` `buildSessionDeck` layout engine and shows an OFFLINE + press-to-launch screen when the daemon is down.

**Direct-HID fallback — fully removed.** Node direct-HID was deleted on 2026-07-08. The dormant Swift `D200hHidModule`, its stand-down arbitration, USB entitlement, direct-device diagnostics, and the legacy `zkswe/` research tree were deleted on 2026-07-14. Both daemons now derive D200H connectivity solely from `ulanzi-plugin` WS presence; the physical rendering/control path remains inside Ulanzi Studio.

**OFFLINE brand mark.** When the daemon is down, the Stream Deck keypad, Stream Deck+ encoder, and D200H all render the canonical **AgentDeck dome-over-deck brand mark** (aquarium-tide cyan on ink) — parity with the macOS/iOS/Android connection overlays and the ESP32 splash. SVG SSOT: `renderAgentDeckMark()` + the `'agentdeck'` glyph + the `'brand'` tone in `shared/src/svg-renderers/session-slot-renderer.ts` (ported from `AgentDeckLogo.swift`). All offline paths route through it (`renderDisconnectedSlot` / `renderOpenAppGrid`/`Quadrant` / `renderOfflineTouchStrip`; D200H `buildSessionDeck` hero; plugin 인코더 offline 배너).

## Display sleep/wake sync

`DisplayMonitor` → `display_state` BridgeEvent → all devices dim/restore. Node daemon fuses a persistent python3 `CGDisplayIsAsleep()` 250ms poll with fallback `pmset IODisplayWrangler`, `ioreg` lock/session presence, and `ScreenSaverEngine` polling. Swift receives `NSWorkspace` screen sleep/wake notifications directly, retaining its 2s CoreGraphics poll as a repair path and lock/screensaver/session-active aggregation. `displayOn=true` means the user is present and the host display is on. `DISPLAY_FORWARDED_EVENTS` includes `display_state` (auto-propagates to `SERIAL_FORWARDED_EVENTS`).

State changes are pushed immediately; the 15s WebSocket and 5s serial re-syncs
repair missed edges and are not the intended response latency. Measure from
an independently observed macOS state change, separately from the sleep request:
user input or an OS fade can postpone or reverse the actual display transition.
The opt-in [display-only acceptance](testing.md#signed-swiftnode-lifecycle-acceptance)
checks isolated Swift-only, Node-only and Node-owner/Swift-client configurations
without suspending the Mac or redirecting shared physical devices.

- **Pixoo**: `setBrightness(0)` + stream pause (saves HTTP), wake restores `dev.brightness`
- **SD+ Plugin**: gate in `plugin/src/display-dim.ts` → black SVG on all buttons/LCDs, wake → `broadcastStateUpdate()` re-render (which also repaints keypad slots — `sessions_list` only fires on change and would leave them black). **Every paint chokepoint consults `isDisplayDimmed()`, not just `broadcastStateUpdate()`**: the usage encoders (`usage_update` ticks), the volume encoder (poll timer), and the keypad (awaiting/processing animation timer) each repaint on their own schedule and will otherwise overwrite the black frame seconds after sleep. Actions appearing while already dark never saw the sleep edge, so their `onWillAppear` calls `dimActionIfNeeded()`
- **Apple iOS**: `DisplaySyncService` — `UIScreen.main.brightness` save/0/restore, background queuing, disconnect safety restore, Settings toggle
- **Android**: `BrightnessController.dim()/restore()` — LCD: `WRITE_SETTINGS` 특수 권한 필수 (manifest 선언만으로 부족, `adb shell appops set dev.agentdeck WRITE_SETTINGS allow` 또는 Settings UI에서 "Modify system settings" 허용 필요, 앱 재설치 시 초기화됨), brightness→0 + SCREEN_OFF_TIMEOUT→2s. `MainActivity` also drops `FLAG_KEEP_SCREEN_ON` when host display is off and dim mode is full-off (including legacy events without `dim`) so tablets can actually sleep; `min` mode keeps the window awake at low brightness. E-ink keeps the screen awake by design and dims only frontlight/backlight via sysfs `/sys/class/backlight/{device}/brightness` dynamic probe (`KNOWN_BACKLIGHT_DEVICES`) — Crema S(warm/white) 동작, **Pantone 6 sysfs는 SELinux 차단으로 dim 스킵** (proc `/proc/aw99703/led_*`도 앱 context에서 읽기/쓰기 불가, root 필요)
- **ESP32**: event delivered via serial, firmware handler TBD
