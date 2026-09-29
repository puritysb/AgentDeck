# 2026-08-04 — Node daemon Codex Desktop rollout discovery (#69)

### 문제
Node passive observer가 `codex app-server`를 제외하고 PID당 rollout 하나만 보존해
Codex Desktop 대화를 전부 놓쳤다. 단순히 app-server를 허용하면 내부 subagent까지
세션으로 노출되고, 5초마다 모든 rollout을 동기 read/parse해 daemon event loop도
막을 수 있었다. 또한 한 app-server PID가 여러 대화를 소유하므로 PID dedupe는
hook으로 잡힌 한 대화 때문에 모든 sibling 대화를 숨긴다.

### 해결
- app-server의 open rollout을 1:N으로 수집하고, Desktop 행은 `codex-app` 및
  `observed:codex-app:<sessionId>`로 분류한다.
- `session_meta.payload.source: { subagent: ... }`인 내부 rollout은 제외한다.
- `(path, mtimeMs, size)` 기반 `CodexRolloutCache`를 추가했다. unchanged summary는
  재사용하고 changed 파일만 `fs/promises` head+tail read/parse하며, 더 이상 open되지
  않은 path는 즉시 invalidation한다. rollout read는 순차 await로 per-scan 메모리를
  한 sample로 제한한다.
- Desktop dedupe는 raw session id를 우선한다. 같은 app-server PID라는 이유로 sibling
  conversation을 제거하지 않는다. CLI의 기존 managed-PID/descendant dedupe는 유지한다.

### 검증
app-server 1:N, subagent 제외, cache reuse/change/removal, Desktop sibling dedupe 회귀를
추가했다. 전체 144 files / 2,383 tests, workspace TypeScript, build가 통과했다.

---
