# 2026-04-19 — iTerm2 postit 오버레이 축소 (project + model 만 표시)

### 문제
`bridge/src/terminal-status.ts` (559줄) 의 iTerm2 postit 배지는 도구 호출 이력 → MLX/Ollama 로 라운드·세션 요약 → 최대 5개 마일스톤 누적 + 휴리스틱 폴백까지 덩치가 컸다. Claude Code 본체에 recap 기능이 내장된 뒤로는 이 두 번째 히스토리 뷰가 상시 중복이 됐고, 배경에서 돌아가는 MLX/Ollama 요약 호출이 가치 없이 로컬 LLM 자원을 점유했다.

### 해결
postit 역할을 "지금 이 탭이 어느 프로젝트의 어느 모델에 붙어있는지" 만 알려주는 식별자로 축소.
- 배지 2줄: `📂 {project}` / `{model}` — 모델이 `null` 이면 한 줄
- 탭 제목: `{project} · {model}` — 상태 아이콘·tool detail 제거
- User Variables: `agentdeck_project` + `agentdeck_model` (기존 `_state`/`_tool` 삭제)
- `BADGE_MAX_HEIGHT_FRACTION` 0.35 → 0.1

`bridge/src/terminal-status.ts` 559 → 167줄. `bridge/src/timeline-summarizer.ts` 에서 유일 caller 를 잃은 `summarizeSessionContext` / `summarizeRound` / 전용 프롬프트 + 연쇄적으로 죽어 있던 `callLLMWithFallback` / `callMLXGeneric` / `callOllamaGeneric` / `callLLMMultiLine` / `callLLMRaw` 를 함께 제거 (232줄). OpenClaw 경로의 `summarizeResponse` 는 유지.

### 핵심 설계 결정
- Dynamic Profile / dark-light 감지 / tmux 래핑 / `--no-postit` 플래그 / 200ms debounce / `stateMachine.state_changed` 훅은 그대로. 축소는 "표시 내용" 만 건드리고 "표시 경로" 는 건드리지 않음 — 이후 롤백이 필요할 때 render/buildBadge 만 부풀리면 됨.
- 탭 제목에서 상태 아이콘(`●`/`◇`) 도 제거. recap 이 탭 바깥에서 본인 역할을 하므로 탭 제목은 순수 식별자로 쓰기로 함.
- MLX/Ollama 호출 경로 자체가 사라져서 local LLM 서버 부재 시 실패 backoff 코드도 안 걸림 (`bug_local_llm_probe_no_backoff` 메모리의 한 축을 정리).

---
