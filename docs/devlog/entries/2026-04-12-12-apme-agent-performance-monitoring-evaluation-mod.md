# 2026-04-12 — APME (Agent Performance Monitoring & Evaluation) module

### 문제
에이전트 세션의 작업 품질을 평가하고 모델 간 성능을 비교할 수 없었음. "이 모델이 이 유형의 작업에 더 나은가?" 같은 질문에 답할 데이터가 없음.

### 해결
APME 모듈 전체 구현 — SQLite store, collector, eval runner (deterministic + LLM judge), rubric auto-tuner, outcome detector, efficiency calculator, composite scorer, task classifier, web dashboard, CLI 11개 서브커맨드.

### 핵심 설계 결정

1. **에이전트 기여(delta) 중심 평가**: 프로젝트 절대 상태(테스트 pass/fail)가 아닌, 에이전트가 세션 전후로 만든 변화를 평가. 기존 빌드 에러가 있어도 에이전트 기여는 정확히 측정.

2. **Outcome signals > Vibe checks**: 사용자의 approve/reject 는 노이즈 (탐색적 실행, A/B 테스트 등). committed/abandoned/iterated 같은 행동 신호가 더 신뢰성 높음. Composite = outcome(0.4) + judge(0.3) + efficiency(0.2) + vibe(0.1).

3. **Turn-level evaluation**: 세션 단위가 아닌 프롬프트 단위 추적. `UserPromptSubmit` → turn open, 다음 prompt 또는 session_end → turn close. 각 turn 에 prompt + response + tool stats.

4. **MLX 기본, API opt-in**: 모든 LLM 작업(judge, classifier)은 로컬 MLX 서버 기본. API 비용 0원. 사용자가 명시적으로 opt-in 해야 Anthropic API 사용.

5. **Hook + PTY parser 이중 수집**: Claude Code v2.1.104 에서 `UserPromptSubmit` hook 이 fire 안 됨. `PreToolUse`/`PostToolUse` 는 `matcher: "*"` 필요 (빈 문자열은 매치 안 함). PTY parser 의 `user_prompt` metadata + `tool_start`/`tool_end` parser event 가 fallback.

6. **Swift-native APME**: App Store 배포를 위해 Swift daemon 에도 ApmeStore/Collector/Classifier/HttpRoutes 구현. Node.js 와 같은 `apme.sqlite` 공유 (WAL mode). 독립 동작 가능.

7. **Channels/MCP 는 불필요**: Channels 는 외부→Claude 방향(이벤트 주입)이고, APME 는 Claude→외부 방향(데이터 수집). 목적이 반대.

### 교훈

- **Node.js zombie 프로세스**: hook-server SSE heartbeat `setInterval` 에 `.unref()` 누락 → event loop 이 안 끝남 → 포트 점유. 모든 shutdown 경로의 timer 에 `.unref()` 필수.
- **NWListener NECP 에러**: 짧은 시간 내 listener 생성/파괴 시 macOS 커널의 NECP path 업데이트 실패 → `.failed` state 방출 → daemon shutdown. Non-fatal 이므로 무시해야 함.
- **Hook matcher**: Claude Code 의 tool-specific hook (PreToolUse/PostToolUse) 에서 `matcher: ""` = "match nothing". `matcher: "*"` 사용 필수.
- **message.content**: Claude Code v2.1+ 의 UserPromptSubmit 은 `{ message: { content: "..." } }` 형태. `{ prompt: "..." }` 아님.

---
