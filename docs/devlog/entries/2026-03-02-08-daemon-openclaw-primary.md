# 2026-03-02 — Daemon/OpenClaw primary 세션 카운트 불일치

### 문제
실제 coding agent 3개 실행 중인데 크레마(e-ink)에서 1개, 태블릿에서 4개 표시. 원인 2가지:

1. **Daemon self-filter 실패**: Daemon의 `sessions_list`에서 자신을 제거하지만, `connection` 이벤트의 daemon UUID가 siblings에 없어 클라이언트 self-filter 불가 → primary(daemon) 1 + siblings 3 = 4개
2. **Daemon agentType 변동**: `daemon-server.ts`가 OpenClaw gateway alive 시 `agentType: 'openclaw'`로 보고 → `!= "daemon"` 체크 통과 → openclaw primary가 octopus creature로 렌더링

### 해결
**클라이언트(Android) 3곳에서 필터링**:
- `EinkAgentColumn.kt`, `SessionListPanel.kt`: primary `agentType == "daemon"` → 스킵. Sibling `agentType == "daemon"` → 스킵. OpenClaw는 🦞 아이콘으로 정상 표시
- `TerrariumState.kt`: primary/sibling `"daemon"` 또는 `"openclaw"` → octopus 목록에서 제외 (crayfish가 별도 처리)

### 교훈 / 핵심 설계 결정
- **Daemon agentType 변동 주의**: `daemon-server.ts`가 gateway 상태에 따라 `agentType`을 `"daemon"` ↔ `"openclaw"`로 전환. 클라이언트에서 `"daemon"` 하나만 체크하면 gateway alive 시 필터 실패
- **Session list vs Terrarium 분리**: 에이전트 목록에는 OpenClaw 표시 (🦞), terrarium에서는 crayfish로 표현 → 두 레이어의 필터링 규칙이 다름
- **Primary vs Sibling 필터 차이**: Primary는 bridge가 자신을 보고하는 것 (daemon/openclaw 스킵). Sibling은 sessions_list에서 오는 것 (daemon만 스킵, openclaw는 표시)

---
