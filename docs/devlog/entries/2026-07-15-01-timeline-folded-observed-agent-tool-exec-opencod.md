# 2026-07-15 — Timeline: folded 큐잉 프롬프트 + observed-agent tool_exec 억제 + opencode idle TTL

### 문제
타임라인에서 Claude/Codex는 깔끔한데 특정 관측(observed) 케이스가 이상하게 렌더됐다. ① Codex 세션에 프롬프트를 빠르게 두 번 넣으면 앞 프롬프트가 "진행중 마크가 남고 응답 없음"으로 고착. ② OpenCode 턴은 프롬프트 아래 `bash`/`bash completed` 툴 행 무더기 + 응답 없음으로 도배. ③ (부수) 긴 OpenCode 턴이 조용하면 창이 조기 종료된 것처럼 보이는 flap 위험.

### 해결
- **큐잉 프롬프트 folded 렌더** (`e8b03573`): 관측 에이전트는 연속 프롬프트를 한 턴으로 합치고 Stop을 한 번만 내며, 그 응답의 `startedAt` 앵커가 **가장 최근에 열린 턴**에 찍힌다(`sameTurnAnchor`). 앞 프롬프트의 `chat_start`는 매칭 완결을 못 받아 고아가 된다. 이를 "folded"로 탐지해 `↳` 글리프 + "answered with next turn" 노트로 표시하고, 디테일 패널은 뒤 턴의 공유 응답을 차용, 흡수한 턴엔 "shared" 태그. Apple/Android 2미러 + 각 4테스트.
- **observed-agent tool_exec 억제** (`c25d880b`): OpenCode observer 플러그인이 내부 Bash/read/todowrite마다 tool_exec 행을 append하는데, Codex는 이미 low-signal 억제 대상이었지만 OpenCode는 빠져 있어 타임라인을 도배했다. `agentType == "opencode"`를 **4미러**(shared/Swift storage drop + Apple/Android display filter)에 추가해 Codex와 동일 처리. chat/task 행 유지, APME는 hook trajectory를 읽으므로 무관.
- **opencode idle TTL** (`d330778d`): `evictStaleHookSessions`가 opencode를 180s ghost TTL로 reap → 조용한 라이브 턴이 조기 close(가짜 chat_end)+creature flap. 표준 opencode는 항상 interactive(플러그인은 standalone만 부착)이므로 `openCodeIdleTTL=30min`(codexInteractiveIdleTTL 미러) 부여.
- **antigravity forward-compat** (`ffdfa558`): Node `classifyObservedHookEvent`가 `antigravity_*`를 이미 수용(프로듀서 없음). AGY observer가 생기면 tool_exec가 홍수날 수 있어 4미러 억제 목록에 미리 추가. 오늘 동작 변화 없음.

### 핵심 설계 결정
- 관측 에이전트별 tool_exec 억제는 **agentType 명시 opt-in — 4미러**(2 storage: shared/Swift, 2 display: Apple/Android). 신규 관측 에이전트는 4곳 모두 추가해야 한다. Node는 storage에서 drop하지만 Swift daemon은 opencode를 append했으므로 display 필터가 과거 timeline.json 잔여도 잡는다.
- turn 완결 신호는 에이전트별로 다르다: Claude=Stop hook+transcript+orphan reaper, Codex=rollout tail, OpenCode=**session.idle 단일 의존** → missed-idle 백스톱은 eviction reaper뿐. 그래서 opencode는 interactive TTL로 조기 reap을 막는 게 중요하다.
- AGY는 현재 usage/quota 폴러 전용이라 타임라인 미생성 — 문제 표면 자체가 없다.

### 검증
- Shared: tsc + vitest 66. Apple: macOS BUILD SUCCEEDED, `AgentDeckTests_macOS` TimelineTests 69 / OpenClawToolNoiseTests 38 통과. Android: `:app:testDebugUnitTest` TimelineDisplayScenarioTest·TimelineStoreTest 통과(각 fold/opencode/antigravity 신규 케이스 포함).
