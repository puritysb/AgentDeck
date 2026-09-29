# 2026-04-18 — MLX Atomic Model Pin (single source of truth)

### 문제
Dashboard (macOS ControlTowerPanel `mlxRow`) 에 MLX 모델이 두 개 나란히 표시:
`mlx-community/Qwen3.5-35B-A3B-4bit, mlx-community/Qwen3.6-35B-A3B-4bit`.

실측:
- `mlx_vlm.server` PID 한 개가 127.0.0.1:8800 리슨 (wrapper.sh 자식들은
  `> >(ts_pipe ...)` process substitution 서브셸 — 정상).
- `/v1/models` 가 `~/.cache/huggingface/hub/` 에 내려받힌 두 버전을 **모두**
  advertise.
- AgentDeck 의 MLX probe (TS `mlx-probe.ts`, Swift `DaemonServer.probeMLX`) 가
  `nanollava` 만 빼고 그대로 `state.mlxModels` 에 broadcast.
- `bridge/src/timeline-summarizer.ts` (3 곳) + Swift `TimelineSummarizer` +
  `plugin/src/label-summarizer.ts` 가 `Qwen3.5-35B-A3B-4bit` 를 **하드코딩**.
- APME judge 만 `/v1/models` 자동탐지로 첫 결과를 잡아 썼기 때문에
  **summarizer 와 judge 가 서로 다른 모델로 동작할 수 있는 상태**.
- Settings 저장소에는 placeholder `"qwen3-30b"` 만 존재, 실제 모델 id 와 무관.

### 해결
**Single source of truth: `~/.agentdeck/settings.json` → `llm.mlx.{endpoint,model}`**

- `shared/src/llm-settings.ts` (신규): `loadMlxSettings()`,
  `resolveMlxModel(probeFirst)`, `mlxChatUrl()`, `MLX_FALLBACK_MODEL`. 30s TTL
  캐시. Placeholder (`""`, `"default"`, `"qwen3-30b"`) 는 모두 unset 으로 간주.
  Legacy fallback: `apme.judge.{endpoint,model}`.
- `apple/AgentDeck/Daemon/Apme/ApmeSettings.swift` 에 `LlmMlxConfig` +
  `loadMlxConfig()` 미러 (30s 캐시, `nonisolated(unsafe)` 로 Swift 6
  concurrency 통과).
- **Probe 필터**: TS `fetchMlxModels(pin?)` + Swift `probeMLX` — pin 이 결과에
  포함되면 `[pin]` 만 broadcast, 아니면 전체 리스트 (기존 동작). Dashboard 는
  코드 수정 없이 자연스럽게 1 개만 노출.
- **Consumer 일원화**: timeline-summarizer (3 곳) / label-summarizer /
  APME judge / Swift TimelineSummarizer / Swift ApmeJudgeMlx 모두
  `resolveMlxModel(probeFirst)` 또는 `ApmeSettings.loadMlxConfig().model`
  우선 → 없으면 probe 첫 결과 → 최종 폴백 `Qwen3.6-35B-A3B-4bit`.
- **judgeModel DB 태그 정확화**: `effectiveJudgeModelTag(cfg)` — MLX backend
  일 때 pin 이 있으면 `mlx:<pin>`, 없으면 `mlx:<cfg.model>`. Non-MLX 백엔드는
  `cfg.model` 그대로.
- **TS probe 백오프**: `startMlxProbe` 에 exponential backoff (5→30s 캡)
  도입. Swift `probeMLX` 의 `mlxFailureCount`/`mlxNextInterval` 패턴 미러.
  `bug_local_llm_probe_no_backoff.md` 처방.

### 핵심 설계 결정
- **`llm.mlx` 를 `apme.judge` 에서 분리**: summarizer 는 APME 와 무관한데도
  같은 모델을 써야 하므로 settings 루트의 독립 블록. `apme.judge.model` 은
  backward compat 용으로 legacy fallback 만 유지 (placeholder `"qwen3-30b"`
  그대로 둠).
- **카탈로그를 UI 에서 숨기는 게 아니라 probe broadcast 자체를 `[pin]` 으로
  축소**: 이유 (a) 모든 dashboard (macOS/Android/iOS/TUI) 가 동일하게 반영,
  (b) usage-event/state-update payload 가 작아짐, (c) sibling bridge 의
  구버전 broadcast 와 focus relay override 가 이미 "daemon 캐시가 권위"
  모델이므로 추가 플럼빙 불필요.
- **Placeholder 판정을 엄격히**: `"qwen3-30b"` 는 실제 모델이 아니라
  기본값이어서 유저가 "이거 바꿔야지" 를 놓치기 쉬움 → 무조건 null 처리.
- **`nonisolated(unsafe)` 정적 캐시**: 30s TTL 은 race 가 나도 손해가 pure
  read-miss 한 번이므로 락 없음 선택. 기존 `ESP32Serial`, `AdbModule` 등과
  동일 패턴.
- **Settings UI picker 는 이번 범위 밖**: 현 단계는 `settings.json` 수동
  편집. Picker 를 붙이려면 "pin 적용 전 전체 리스트" 가 별도로 필요해서
  `unfilteredMlxModels` 같은 추가 state 필드가 생기는데 그 부분은 Phase 2.

검증: `pnpm test` 918/918 (신규 12 개 포함) + `xcodebuild -scheme
AgentDeck_macOS build` 성공. 런타임 활성화는 `~/.agentdeck/settings.json`
에 `"llm": { "mlx": { "model": "mlx-community/Qwen3.6-35B-A3B-4bit" } }`
추가 후 daemon 재시작.

플랜: `~/.claude/plans/mlx-atomic-minsky.md`. 커밋: `fbe1cdb9`.

### 후속 (`2b7b38b3`) — auto-pick default
`fbe1cdb9` 직후 사용자 확인: dashboard 에 여전히 두 개 표시. 원인 두 가지 —
(a) AgentDeck.app 이 세션 내내 구버전 바이너리로 돌고 있어 새 probe 필터가
반영되지 않음, (b) `settings.json` 에 `llm.mlx` pin 이 없는 상태였고 내 기본
동작이 "pin 없으면 전체 broadcast" 였음. (a) 는 사용자가 재기동으로 해결,
(b) 를 고치기 위해 **pin 이 없고 카탈로그가 >1 이면 첫 번째를 자동 선택**
하도록 기본값 변경 (TS `mlx-probe.ts` + Swift `probeMLX`). APME judge 의
기존 "first non-nanollava" auto-detect 와 동일 규칙이라 summarizer/judge
동작이 자동으로 수렴. 명시 pin 은 여전히 override. 카탈로그가 1 개뿐이면
그대로 — 회귀 없음.

**교훈**: "pin 없을 때 회귀 없음" 을 과하게 보수적으로 설계했음. 실제로는
기본값이 sensible auto-pick 이어야 사용자 입장에서 "고쳐진 느낌" 이 남.
새 기능의 default 는 항상 "비어 있는 설정으로도 합리적인 결과" 를 내야 함.

---
