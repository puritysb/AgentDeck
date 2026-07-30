---
id: spec.streamdeck-layout
title: Stream Deck+ Layout
description: The current session-per-button keypad, the four encoder assignments, and the immutable action UUID mapping.
category: Specs
locale: en
canonical: true
status: stable
owner: Plugin maintainers
reviewed: 2026-07-21
revision: 2026-07-21
source_of_truth: docs/streamdeck-layout.md
validators: [pnpm test]
---
# Stream Deck+ Layout

**Manifest actions** (5 total): `session-slot` (Keypad; device-grid aware) + 4 encoders on Stream Deck+.
The earlier mode-dial keypad and the capabilities dropped on the way here are recorded in
[Retired and Experimental Surfaces](retired-surfaces.md).

UUIDs are immutable post-distribution, so several no longer describe their role. Current mapping:

| UUID | Display name | Role |
|---|---|---|
| `session-slot` | Session Slot | Keypad, device-grid aware |
| `utility-dial` | Volume | E1 — macOS output volume |
| `option-dial` | Claude Usage | E2 — Claude quota gauge |
| `iterm-dial` | Codex Usage | E3 — Codex quota gauge |
| `launcher` | Launcher | E4 — open an agent |

## Keypad

All keypad buttons are `session-slot`; the plugin reads the physical device grid from Stream Deck and maps `slot = row * columns + column`.

| Device | List View | Detail View |
|--------|-----------|-------------|
| Stream Deck+ (4×2) | 8 sessions, or 7 + NEXT | 0 BACK, 1 INFO, 2/3/4/5 content, 6 MORE, 7 ESC/STOP |
| Stream Deck (5×3) | 15 sessions, or 14 + NEXT | 0 BACK, 1 INFO, 2-12 content, 13 MORE, 14 ESC/STOP |
| Other key grids | `keyCount` sessions, or `keyCount - 1` + NEXT | 0 BACK, 1 INFO, last ESC/STOP, penultimate MORE, remaining content |

No daemon: single recovery hero. The geometric center key (`floor(rows/2) * columns + floor(columns/2)` — SD+ 4×2 → slot 6, SD MK2 5×3 → slot 7, SD XL 8×4 → slot 20, SD Mini 3×2 → slot 4) shows **OFFLINE / Open AgentDeck** and launches the AgentDeck Dashboard app on press; every other key is intentionally dark and inert. Auto-reconnect handles re-discovery so no manual RETRY affordance is exposed.

No session while daemon is connected: healthy idle dashboard, not recovery UI. Slot 0 = **HUB READY / CONNECTED**, slot 1 = **NO SESSION / WAITING**, slot 2 = **AgentDeck / IDLE**, rest intentionally dark. These are icon-rich image cards; they must not fall back to text-only `Empty` buttons.

**OpenClaw presets** (detail view): STATUS, MODEL (dynamic model name + switch), GATEWAY (browser). In PROCESSING, current tool/status is shown before these presets.

## Agent Session UX Scenarios

목표는 모든 하드웨어에서 같은 mental model 을 유지하는 것이다: **세션 버튼은 들어가기, 상세 화면은 상태 기반 명령, BACK 은 빠져나가기**. 다만 화면/입력 장치 특성에 따라 정보 밀도와 조작 깊이를 다르게 둔다.

### Stream Deck / Keypad-only

- **List**: 각 키는 하나의 세션이다. AgentDeck terrarium creature mark + 상태 링으로 빠르게 훑는다.
- **Press session**: 먼저 선택 세션의 list-state 로 상세 화면을 즉시 표시하고, daemon focus relay 가 도착하면 tool/options/current model 을 갱신한다. 사용자는 빈 화면이나 다른 세션 옵션을 보지 않는다.
- **Detail idle**: GO ON / REVIEW / COMMIT / CLEAR 를 1-tap 명령으로 두고, 남는 칸은 MODEL/MODE/READY 이미지 카드로 채운다.
- **Detail awaiting**: 실제 parser options 를 아이콘이 붙은 선택 카드로 노출한다. overflow 는 MORE 로 페이지 전환한다.
- **Detail processing**: 현재 tool/status 를 첫 content 키에 고정하고, STOP 을 항상 기기의 마지막 버튼에 둔다. OpenClaw 도 STATUS/MODEL/GATEWAY 보다 현재 작업 문맥을 먼저 보여준다.

### Stream Deck+

- Keypad UX 는 Stream Deck 과 동일하지만, encoder 가 상세 화면의 보조 조작면이다.
- E1 은 볼륨, E2/E3 는 Claude/Codex usage 게이지, E4 는 에이전트 런처다.
- Session detail 에 들어가면 keypad 는 "결정 버튼", encoder LCD 는 "읽기/스크롤" 역할로 분리한다. 긴 approval 문구를 키 타일에 억지로 넣지 않고 wide canvas 에서 읽게 한다.

### Ulanzi D200H

- 14키/5×3 구조를 살려 **overview 우선**으로 둔다. List mode 는 최대 13세션 + merged usage monitor 이고, 세션을 누르면 optionSelect 로 들어간다.
- D200H 는 실질적으로 정지 이미지 파이프라인이므로 상태 표현은 애니메이션 의존도를 낮춘다. PROCESSING 은 고정 amber ring + STOP, AWAITING 은 밝은 solid/pulse peak ring + 실제 option 버튼으로 읽힌다. D200H 세션 타일은 provider logo path 가 아니라 terrarium creature 축약형(Claude robot, Codex cloud prompt, OpenClaw crayfish, OpenCode nested square)을 그린다.
- D200H no-session/detail action 텍스트는 native label 에만 맡기지 않고 PNG 에 직접 굽는다. `HUB READY / NO SESSION / AgentDeck`, quick actions, STOP/ESC/MORE/BACK 은 모두 icon + baked label 구성을 유지한다.
- Detail mode 는 BACK(0/13), INFO(1), options/quick actions(2-9), STOP/ESC(10), MORE(11) 의 고정 좌표를 유지한다. 손이 기억해야 하는 위험 명령은 STOP/ESC 하나뿐이다.
- 버튼 명령은 선택된 sessionId 를 기준으로 전달한다. 포커스 전환 지연 때문에 다른 세션으로 STOP/option 이 가는 일을 막는다.

## Encoders (4 slots)

| E# | Action | Rotate | Push |
|----|--------|--------|------|
| E1 | Volume | Adjust output volume | Toggle mute |
| E2 | Claude Usage | Cycle view (both/5h/7d/session) | Refresh usage data |
| E3 | Codex Usage | Cycle view (both/5h/7d/session) | Refresh usage data |
| E4 | Launcher | Select agent | Open agent |

No encoder handles LCD touch.

When the daemon is down, all four LCDs render one 800px OFFLINE banner and a press
opens the AgentDeck app.

## Marketplace submission constraints

**Published 2026-07-28:** version 1.0.2 is live at
[marketplace.elgato.com/product/agentdeck-…](https://marketplace.elgato.com/product/agentdeck-dce3806b-176e-40f2-be7d-e029bec0f464).
The constraints below stay binding for every subsequent revision.

Decided for the 2026-07-19 submission and still binding. The capabilities that were
dropped to get here — the voice dial, the multi-mode utility dial, the project picker —
are in [Retired and Experimental Surfaces](retired-surfaces.md).

- **macOS and Windows.** Session keys and usage dials are platform-neutral.
  Volume and Launcher dispatch through `utility-modes/system-control.ts`:
  macOS uses `osascript` / `open -a`; Windows uses built-in PowerShell media
  keys and Start Apps/browser launch. Keep both manifest OS entries covered by
  `manifest-platform.test.ts`.
- **`SDKVersion: 3` — required, not a choice.** We shipped 2 first on the reading that 3 is merely the opt-in flag for DRM (plugin encryption) rather than an API level. Maker Console refuted that on upload (2026-07-20): it flags 2 with *"Minimum Manifest SDK version must be 3 or later"* and disables Continue, so a `SDKVersion: 2` bundle cannot be submitted at all. DRM is not separately selectable either — the console's second flag reads *"DRM protection is not enabled due to SDK compatibility"*, i.e. DRM follows from the SDK version.

  The original concern is **still open**: DRM is applied server-side after upload, so a local `streamdeck pack` cannot prove the encrypted build still works, and Elgato does not document how encryption treats the custom encoder layout JSON the four encoders load by path. Since 3 is mandatory, the mitigation is the review loop, not the version choice — upload with "publish after review" unselected, download the processed build, and verify the encoders before going live.
- **OS floors:** `mac MinimumVersion: 26.0` matches the Swift daemon deployment
  target (`apple/project.yml`); `windows MinimumVersion: 10` follows Elgato's
  supported manifest form. The tested AgentDeck bridge baseline remains Windows
  11 as documented in [windows.md](windows.md).
