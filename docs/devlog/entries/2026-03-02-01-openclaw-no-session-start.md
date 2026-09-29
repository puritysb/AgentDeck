# 2026-03-02 — OpenClaw ↔ NO SESSION 토글 + START 버튼

### 문제
CC 세션 없이 OpenClaw Gateway만 연결된 상태에서 Session 버튼을 누르면 아무 일도 안 됨 (cycle list에 OpenClaw 1개만 있어서 early return). 또한 NO SESSION 전환 시 Usage 버튼과 E2/E3 타임라인이 여전히 OpenClaw 모드로 남아있는 문제.

### 해결
**가상 `cc-nosession` CycleEntry 추가** (`session-button.ts`): Gateway 연결 + CC 세션 0개 → cycle list에 `cc-nosession` 가상 엔트리 삽입. OpenClaw ↔ NO SESSION 토글 가능. NO SESSION에서 response-button의 기존 START→picker→`sdc` 인프라 재활용.

**`setNoSessionMode()` 헬퍼**: 진입/탈출 시 `setCcNoSessionMode` (response-button), `setUsageCapabilities(null/caps)`, `updateOptionDialState(caps: null/caps)`, `updateItermDialState(caps: null/caps)` 일괄 호출. capabilities null → usage는 CC 기본 페이지(5h/7d), E2/E3는 기본 동작(prompts/iTerm)으로 복귀.

**자동 전환**: file watcher가 새 CC 세션 감지 시 NO SESSION 모드 자동 해제 + `resetToAuto()`. `updateSessionButton`에서 CC agentType 도착 시에도 해제.

### 교훈 / 핵심 설계 결정
- **가상 상태는 모든 컴포넌트에 전파해야 함**: session/response 버튼만 플래그를 알고 다른 컴포넌트(usage, encoder dial)는 여전히 gateway capabilities를 보면 UI 불일치. `setNoSessionMode()` 같은 일괄 전파 헬퍼가 필수
- **"OC" 약자 사용 금지**: Opencode, Codex CLI 등 추가 예정으로 "OC"가 모호해짐. 코드/코멘트에서 풀네임(OpenClaw, Opencode 등) 사용

---
