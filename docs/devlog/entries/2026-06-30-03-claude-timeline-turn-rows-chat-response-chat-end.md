# 2026-06-30 — Claude timeline turn rows: chat_response와 chat_end 중복 제거

### 문제
Claude Code turn 하나가 `chat_start` + `chat_response` + dimmed `chat_end` 3행으로 flat timeline 표면(Stream Deck plugin, TUI, persisted `timeline.json`)에 남아 실제 작업 단위가 과도하게 쪼개졌다. Android/macOS dashboard projection은 paired `chat_end`를 렌더 단계에서 대부분 숨기지만, 저장/relay/flat surface에는 중복 metadata row가 계속 흘렀다.

### 해결
- Node `bridge/src/index.ts`: 응답 텍스트가 있으면 `chat_response`만 turn completion row로 emit하고, 응답이 없는 tool-only/response-less turn에서만 `chat_end`를 emit.
- Voice assistant는 더 이상 `chat_end.detail`만 보지 않고 `chat_response`를 우선 읽고 `chat_end`를 fallback으로 사용.
- Swift `DaemonServer.swift`: Node와 같은 계약으로 `assistantText`가 비어 있을 때만 `chat_end`를 생성. 응답 있는 turn의 LLM summary 기반 `chat_end` upsert 경로는 제거.
- Android stale test 보정과 맞물려 Codex/Claude device timeline은 chat/task lifecycle row 중심으로 유지.

### 검증
- `pnpm build` 성공(bridge TypeScript compile 포함).
- Android `:app:testDebugUnitTest` 성공. Claude paired `chat_end` suppression 기대와 Codex tool firehose 제거 기대가 모두 녹색.

---
