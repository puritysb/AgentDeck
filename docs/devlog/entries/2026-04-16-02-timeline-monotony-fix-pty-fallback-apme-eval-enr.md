# 2026-04-16 — Timeline monotony fix: PTY fallback + APME eval enrichment

### 문제
Dashboard timeline이 `"Prompt sent" → "Completed · Xs"` 만 반복 표시. Claude Code hook 이벤트(PreToolUse/PostToolUse/Stop)에 100% 의존하는데, Stop hook ~18% 신뢰도로 tool activity가 timeline에서 완전 소실.

### 해결
**Part A — PTY parser → Timeline 연결** (`bridge/src/index.ts` wireClaudeCodeTimeline):
1. PTY `tool_action` → `tool_exec` timeline entry (hook tool_request 미발화 시 2초 디바운스로 대체)
2. PTY `spinner_stop`/`idle` → fallback `chat_end` (Stop hook 1.5초 대기 후 PTY ringbuffer에서 response 추출)
3. `tool_resolved`에 tool name 포함 ("Approved" → "Read approved")
4. `chat_start` 폴백 개선 (project name 포함 + late upsert)
5. `chat_response` 추가 (Stop hook / PTY fallback 양쪽 공유하는 `emitCompletion()` 헬퍼)

**Part B — APME eval ↔ Timeline 연계** (`bridge/src/daemon-server.ts`, `bridge/src/tui/renderer.ts`):
6. TUI renderer `eval_result` 명시 지원 (★ 아이콘 + yellow)
7. Run eval detail에 축 점수 + deterministic 결과
8. Turn eval detail에 judge reasoning (done/missed)
9. Deterministic layer 별도 `⚡` timeline entry
10. Session bridge에서도 turn-level eval_result emit (`runner.onResult` wiring)

### 핵심 설계 결정
- **PTY와 Hook은 경쟁 관계, 둘 다 필요** — Hook이 더 정확하지만 unreliable. PTY는 100% 가용하지만 정보가 덜 구조적. `ccPendingCompletion` 플래그 + 1.5초 타이머로 Hook 우선/PTY 폴백 전략 구현.
- **`emitCompletion()` 헬퍼로 중복 제거** — Stop hook path와 PTY fallback path가 동일한 chat_response + chat_end + LLM summarization 로직 공유. 코드 분기점은 response 텍스트 소스만 다름 (hook: `last_assistant_message`, PTY: ringbuffer ⏺ 마커 추출).
- **Session bridge eval은 turn-level만** — Run-level eval은 deterministic layer(lint/build/test) 포함이라 daemon에서만 처리. Session bridge는 가벼운 turn-level eval만 timeline에 emit.
- **Dedup은 정상 작동 중** — `extractSemanticCore`가 chat_end에서 `·` 이후를 strip → "Completed"가 keyword filler로 빠져 empty set → `isSimilarCore` false. 문제는 dedup이 아니라 이벤트 자체가 빈약했던 것.

---
