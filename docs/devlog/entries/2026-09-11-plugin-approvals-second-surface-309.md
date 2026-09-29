# 2026-09-11 — 승인 표면은 둘이었다: `plugin.approval.*` 를 PERM 으로 (#309)

#308 을 Gateway 번들까지 추적하다 나온 부산물. `openclaw approvals pending` 은 "exec, plugin,
system-agent" 승인을 나열하고 TUI 는 `parseTuiPluginApproval` 로 플러그인 승인을 exec 과 같은
큐에 올리는데, AgentDeck 은 `exec.approval.*` 만 처리했다. 플러그인 승인이 걸리면 어느 표면에도
PERM 이 없다 — PERM 이 존재하는 이유("사람을 기다린다")의 한 부류가 통째로 빠져 있던 것.

### 형식은 그들의 SDK 에서

설치된 `openclaw@2026.9.3` 의 `dist/` 에 `.d.ts` 가 4,962개 있다. exec 표면이 처음에 추측으로
만들어져 전부 틀렸던 전례(`openclaw-approval.ts` 헤더) 때문에, 워커에게 모든 필드·결정값의 출처
파일과 타입을 보고하게 했다: `PluginApprovalRequestPayload` 와 `{approvalKind?, id, request,
createdAtMs, expiresAtMs}` 는 `approval-types-*.d.ts`, 결정 어휘 `allow-once/allow-always/deny` 는
exec 과 같은 Gateway 공유 코드, 기본 severity 는 `"info"` 가 아니라 **`"warning"`**
(`buildPluginApprovalRequestMessage`), `plugin.approval.list` 는 bare array. exec 에 있는
`unavailableDecisions` 는 플러그인 표면에 없어서 일부러 옮기지 않았다.
`plugin.approval.removed` 의 페이로드는 **어느 `.d.ts` 에도 없다** — 임베디드/TUI 브로커의 문자열
리터럴에서만 확인돼서 방어적으로 처리하고 미지원으로 적었다. 기본 종료 경로는 exec 과 같이
30초 reconcile + 레코드 만료.

### 두 승인이 동시에 걸리면

`pendingPluginApproval` 슬롯을 따로 두고(자체 만료 타이머·30초 `plugin.approval.list` reconcile),
`activePendingApproval()` 이 `requestedAtMs` 가 오래된 쪽을 보여준다. 데크의 `respond` /
`select_option` 은 활성 쪽으로 가서 `plugin.approval.resolve` 또는 `exec.approval.resolve` 를
부른다. 보이지 않는 쪽은 타이머를 살린 채 대기하다 앞이 정리되면 자동으로 올라온다 — 조용히
버리지 않는다. 플러그인 승인은 Gateway 단절에는 abandon 하지만 **턴 종료에는 하지 않는다**(exec 과
비대칭): SDK 어디에도 플러그인 승인이 채팅 턴에 묶인다는 보장이 없다.

세션 행의 `question` 에는 `[Plugin] ` 접두어를 붙여 Allow 를 누르는 사람이 무엇을 허용하는지 알게
했다. 여기서 워커가 **출하 전 결함 하나를 잡았다**: 접두어 붙은 문장을 방송하면서 기기 에코는
접두어 없는 원제목과 비교하고 있었다 → 질문을 렌더해 되돌려주는 모든 표면의 누름이 조용히
거부됐을 것. 양 데몬에서 같은 방식으로 고치고 회귀 테스트를 붙였다.

### 게이트·변이

vitest 4,369 · XCTest 825(신규 `OpenClawPluginApprovalRulesTests` 22). 변이: resolve 를
`exec.approval.resolve` 로 → 2 red, `removed` 처리 삭제 → 2 red, 어휘에 `'allow'` 허용 → red(exec
쪽에도 같은 구멍이 있어 "plain allow 절대 제공 안 함" 테스트를 양쪽에 추가), 나이 tie-break 를
exec 우선으로 → 3 red, `[Plugin]` 라벨 제거 → 1 red, Swift 기본 severity → 1 red.

### 기록

같은 번들에 아직 배선되지 않은 **통합 승인 프로토콜**(`packages/gateway-protocol/src/schema/
approvals.d.ts` 의 `ApprovalResolveParamsSchema{kind}`, `SessionApprovalReplaySchema`)이 들어 있다 —
OpenClaw 가 그쪽으로 옮기면 exec/plugin 분기가 한 표면으로 접힌다. 다음 버전 확인 항목.
