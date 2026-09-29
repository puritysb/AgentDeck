# 2026-05-10 — lobe-icons 브랜드 마크 다운스트림 렌더러 정리 (stop-hook iteration)

### 문제

`design/brand/` SSOT 와 `docs/design{,-mockups}/creatures.jsx` 는 lobe-icons
4개 마크(claudecode/codex/openclaw/opencode) 로 정리됐지만, 다운스트림
hardcoded path renderer 들이 옛 sourcing 그대로:
- Apple `CreatureClaudeCode.imageset/claudecode.svg` → lobe `claude.svg`
  (Anthropic swirl, generic Claude mark, Claude Code 전용 아님)
- Apple `CreatureOpenCode.imageset/opencode.svg` → 240×300 viewBox + baked
  color (`#CFCECD`/`#211E1E`) 자체 변형
- Android `BrandIcon.kt` `CLAUDE_PATH` = swirl, `OPENCODE_PATH` = 240×300
  → 24×24 스케일 path
- Apple `SessionBrand.AgentBrandIcon` `claudePath`/`openCodePath` 동일 stale
- `SessionListPanel.swift` 에 promoted 후 잔존한 dead `BrandIcon` struct
  (57 lines, swirl + 240×300 path 보유)

같은 4 브랜드를 표현하는 5개 표면(asset catalog / Compose Canvas / SwiftUI
Path / JSX inline embed × 2 mirror) 이 SSOT 변경 후에도 다르게 렌더되는
드리프트. Codex stop-hook 이 "updated SVG assets leave hardcoded brand
renderers stale" 로 잡았다.

### 해결

- Apple imageset 2개 → lobe-icons (`claudecode.svg` Claude Code-specific
  grid, `opencode.svg` 24×24 currentColor nested-square)
- Android `BrandIcon.kt` `CLAUDE_PATH`/`OPENCODE_PATH` → lobe 24×24 paths
- Apple `SessionBrand.AgentBrandIcon` `claudePath`/`openCodePath` → lobe 24×24
- `docs/design{,-mockups}/creatures.jsx` opencode entry 240×300 → 24×24 +
  주석 정리 (prior 세션이 일부 정리, 잔여 mirror 동기화)
- `SessionListPanel.swift` dead `BrandIcon` struct 제거
- `shared/svg-renderers/agent-logos.ts` `ROBOT_CREATURE_PATH` 는 이미 lobe;
  `CLAUDE_LOGO_PATH` (Anthropic swirl) 는 plugin/test 별도 reference 로
  stale 아님 — 그대로 유지

### 핵심 설계 결정

- **lobe-icons antigravity ↔ claudecode 분리.** 2026-04-19 의 Antigravity
  사고는 lobe-icons claudecode.svg 의 grid 패턴이 Anthropic swirl 과
  혼동된 것. 현재 lobe-icons 는 `antigravity.svg` = swirl/peak shape 로
  분리되어 있어 grid = Claude Code 가 정확. `<title>` 검증 게이트는 여전히
  필수 (Anthropic swirl 을 Claude Code 자리에 잘못 넣는 inverse error
  여전히 가능)
- **다중 표면 동기화 체크리스트.** 같은 SVG 가 inline embed 되는 5곳:
  (1) `apple/.../Assets.xcassets/Creature*.imageset/*.svg`,
  (2) `android/.../ui/component/BrandIcon.kt` path 상수,
  (3) `apple/.../UI/Common/SessionBrand.swift` `AgentBrandIcon` path 상수,
  (4) `docs/design{,-mockups}/creatures.jsx`,
  (5) `shared/src/svg-renderers/agent-logos.ts`. SVG 자산 변경 시 모두
  동기화 필요. 메모리 `brand-renderer-surfaces.md` 참고
- **Stylized vs canonical 구분.** `agent-logos.ts` 의 `openCodeCreatureIcon`
  은 nested rectangle primitive 로 그리는 SD button tile 렌더러로, 의도된
  warm-grey palette. brand mark pixel-accurate reproduction 아니므로 lobe
  SVG 변경에 동기화 불요. Terrarium creature renderers (CloudCreature,
  OpenCodeCreature, CrayfishCreature 등) 도 anim 캐릭터 표현체로 별도
- **Dead code 정리 동반.** Promoted-and-orphaned `BrandIcon` struct 같은
  zombie path 상수는 stale source 로 남기 쉬워 같이 제거. 식별 기준:
  struct 외부에서 생성자 호출 0건 + 기능적 후계자 존재

### 커밋 분리 메모

워킹 트리에 prior 세션의 거대한 미커밋 작업(timeline/daemon/Codex OTel 등
71 files +3642 lines)이 누적되어 있어, 이번 세션의 lobe-icons 변경 중
강결합 부분(`SessionBrand.swift` lobe path = prior 가 추가한
`AgentBrandIcon` 코드 안의 변경, `SessionListPanel.swift` dead struct 삭제
= prior +123 line 변경과 같은 파일)은 분리 staging 비현실적. 깨끗한 3개
파일(`Apple imageset claudecode.svg`/`opencode.svg` + `Android BrandIcon.kt`)
만 `e2f1377c` 로 커밋. 나머지 lobe-icons 변경은 prior 미커밋 묶음과 함께
다음 일괄 처리 시점에 합류 예정.

---
