# 2026-04-13 — Fix missing model names in OpenClaw/OpenCode sessions

### 문제
macOS Dashboard에서 OpenClaw 모델명이 전혀 표시되지 않음. Android/iOS에서도 세션 목록의 OpenClaw 모델명이 빈칸.

**root causes**:
1. (RC-1) session-aggregator.ts의 own-session 엔트리가 modelName을 포함하지 않아서 sessions_list 수신 시 항상 undefined → 모든 adapter 영향
2. (RC-2) OpenCode는 첫 assistant message 전까지 modelID를 얻을 수 없음 (by design — API에서 session 객체에 modelID 미노출)
3. (RC-3) OpenClaw catalog probe(`openclaw models list --json`) 실패 시 emitModelCatalog()에서 null 반환 → model_info 발행 안 됨

### 해결

**Fix 1** (RC-1): session-aggregator.ts + bridge-core.ts
- `enrichSessionsWithState()` 와 `buildEnrichedSessionsList()` 에 `ownModelName?: string` 파라미터 추가
- self-entry 생성 시 modelName 포함: `{ ...base, state: ownState, modelName: ownModelName }`
- bridge-core.ts의 두 호출부에서 `snapshot.modelName ?? undefined` 전달

**Fix 2** (RC-2): OpenCode — 현재 behavior 유지
- OpenCode API가 session의 model을 미노출하므로 현 design (first message 이후 modelID 수신) 이 최적
- Fix 1의 sessions_list 개선으로 자신 세션의 modelName도 state_update에 반영되면 Dashboard에 나타남

**Fix 3** (RC-3): openclaw.ts — fallback modelId 추출
- `chat.final` event handler 에서 payload의 `model` 또는 `modelId` 필드 검사
- 있으면 model_info 발행 (catalog probe 실패 시 최소한 첫 response 이후 model명 표시됨)

### 검증
- session-aggregator tests: ✅ 6 passed
- bridge-core-sessions tests: ✅ 2 passed
- adapter tests: ✅ 93 passed
- output-parser tests: ✅ 221 passed
- TypeScript build: ✅ all packages compiled

---
