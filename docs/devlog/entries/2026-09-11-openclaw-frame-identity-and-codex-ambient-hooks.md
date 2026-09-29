# 2026-09-11 — "OpenClaw 가 남의 명령을 실행 중" 과 Codex 뒷단 스레드: 전역 프레임의 주인, 훅의 출처

두 신고가 같은 아침에 들어왔다. Android 와 macOS 에서 OpenClaw 에이전트가 비정상으로 보였다가
정상이 됐다가 다시 비정상이 된다는 것, 그리고 타임라인에 codex 가 태스크 단위가 아닌 "뒷단"
로그를 잔뜩 남긴다는 것. 게이트웨이 로그는 깨끗했다 — `hasError` 가 참이었던 적이 한 번도 없고,
재시작은 04:26 설정 변경 후 한 번(10초 재접속)뿐이었다. 답은 둘 다 데몬이 남의 것을 자기 이름으로
내보내던 곳에 있었다.

### 전역 `state_update` 의 주인

데몬 허브에는 전역 상태머신이 하나고, 관측된 Claude 훅 전부가 그 머신을 움직인다. 그 스냅샷으로
만든 프레임을 양 데몬은 **게이트웨이 어댑터가 살아 있으면** `agentType: openclaw` 로 찍었고,
Node 는 `projectName` 까지 게이트웨이의 `project_info` 가 마지막으로 쓴 `OpenClaw` 를 그대로
실었다. 새 WS 로 첫 프레임을 받아 보니 `OpenClaw · processing · Bash "cd /Users/…/AgentDeck"` —
내 Claude 세션의 명령이었다. 같은 순간 `sessions_list` 의 OpenClaw 행은 `idle`. 7월의 수정
(`gatewaySessionState`)은 행만 고쳤고 프레임은 그대로였다.

소비자 쪽을 보면 왜 세 표면이 같은 증상을 냈는지 드러난다. Android `AgentState` 는 aggregate
타입(`daemon`/`openclaw`) 의 이벤트면 상태를 aggregate 에 그대로 적용하고("openclaw 가 Claude 의
PROCESSING 을 자기 것처럼"), Apple `AgentStateHolder` 는 `projectName`/`currentTool` 을 HUD 에
올리고, ESP32 `protocol.cpp handleStateUpdate` 는 프레임을 메인 화면 `g_state` 에 복사한다.
다른 세션들이 모두 쉬면 전역이 idle 로 내려가 "정상", 새 턴이 시작되면 다시 "비정상" — 신고된
진동 그대로다.

규칙은 **프레임은 그것을 움직인 주체가 찍는다** 로 바꿨다. 훅 세션이 움직였으면 aggregate `daemon`
+ 그 세션 id + 그 프로젝트, 게이트웨이가 움직였으면 `openclaw` + `openclaw-gateway` + 게이트웨이
자체 스냅샷, 아직 아무도 안 움직였으면 게이트웨이 생존 여부로. `daemon` 과 `openclaw` 는 모든
소비자에서 aggregate 타입이라 크리처는 계속 `sessions_list` 에서 오고, OpenClaw 라벨만 남의 활동에서
떨어진다. Node `bridge/src/hub-state-identity.ts` 가 SSOT, Swift 는 `hubFrameAgentType()` 에
같은 3분기 드라이버(`hook`/`gateway`/`none`)를 뒀다.

적대적 리뷰가 첫 판을 두 군데서 열었다. 하나는 **게이트웨이 접속 프레임** — `connected` 분기와
`switch_agent openclaw` 가 허브 빌더를 우회해 전역 머신 스냅샷을 `openclaw` 로 찍고 있었고,
게이트웨이는 90분에 11번도 재시작하니 원래 버그가 재접속마다 되살아났을 것이다. 그래서
게이트웨이 소유 프레임은 `state` 도 `gatewaySessionState` 로 덮고 도구·옵션 필드를 비운다
(`shapeHubFrame`, Swift `buildFullStateEvent` 의 `openclaw` 오버레이). 다른 하나는 **모델
카탈로그 게이트** — Apple `TopologyRail.catalogOwner` 와 Android `EnginePanel`·e-ink 패널 두 곳이
프레임 `agentType == "openclaw"` 로 OpenClaw 카탈로그 소유를 판정해서, 허브 프레임이 `daemon` 인
동안(관측 세션이 움직이는 내내) 카탈로그 행이 사라진다. 네 곳을 `daemon` + `gatewayConnected` 도
받도록 고쳤다 — 이 부분은 맥 앱과 Android 를 다시 빌드해야 반영된다. 마지막으로 SessionEnd 는
1.5초 예산이라 자주 유실되므로, 턴 워치독이 침묵 세션을 잊을 때 드라이버 소유권도 함께 놓는다
(단 그 세션이 머신에 턴을 열어 둔 채면 — 3분 넘는 빌드나 생각은 훅이 없다 — 살아 있는 것으로 본다).

2차 리뷰는 새 코드에서 셋을 더 찾았다. Apple `AgentStateHolder` 는 `currentTool` 을 키가 없으면
retain 하므로 게이트웨이 프레임이 도구 키를 지워도 직전 Claude 도구가 OpenClaw 라벨 밑에 남는다 —
홀더가 `sessionId` 가 바뀐 프레임에서 도구 필드를 먼저 비우도록 했고, Swift 데몬은
`gatewayCurrentTool` 을 명시적으로 싣는다. 데크에서 OpenClaw 행을 포커스하면 전역 프레임이
`focusedSessionId: openclaw-gateway` 로 나가 훅 구동 상태가 OpenClaw 상세로 흘러들었는데(규칙에
적힌 기존 모양), 포커스 중엔 프레임을 게이트웨이 소유로 강제한다. Swift 의 `awaiting` 분기는
머신의 options/question 을 남겼지만 그건 게이트웨이 것이 아니라(승인은 `gatewayPendingApproval`
에 살고 행으로 나간다) 무조건 버린다.

### Codex Desktop 의 ambient-suggestions

codex 의 "뒷단" 행은 두 종류였다. 18건은 다른 Claude 세션이 `codex exec` 로 이미지를 한 장씩
만든 진짜 실행이고(thread_source `exec`), 10건은 Codex Desktop 이
`~/.codex/ambient-suggestions/<hash>/ambient-suggestions.json` 을 갱신하며 돌린 내부 프롬프트
("Generate 0 to 3 hyperpersonalized suggestions…", "safety and compliance standards for Codex
ambient suggestions…")였다. 이 스레드는 rollout 파일도, Codex 자체 `threads` 테이블 행도 없고
훅 `cwd` 가 `/` 인데, 사용자 전역 훅은 그대로 발화한다. 데몬은 `codex-cli` / project `unknown`
행과 `chat_start`/`chat_response`, 2초짜리 APME turn 을 매번 만들었다 — 07-06 부터 27건.

훅 페이로드에 배경 표식은 없고 `cwd: "/"` 만으로는 루트에서 Codex 를 연 사용자와 구별이 안 되니,
프롬프트 서명으로 `codex_user_prompt_submit` 에서 판정하고(`shared/codex-ambient-vectors.json`,
양 스위트 재생) 그 id 의 이후 훅은 30분 침묵까지 전부 버린다. 프롬프트보다 ~90ms 먼저 온
`codex_session_start` 는 이미 세션 행과 APME run 을 열어 둔 상태라(실측 delta 51–453ms, 전부
미종료) 그 둘을 되돌린다 — 행은 잊고, 아직 빈 run 은 삭제(`store.deleteRun`, Swift 는
`ApmeCollector.discardRun` 신설).

### 남는 것

기존 APME 의 ambient run 27건은 그대로 남아 있다(소급 삭제는 별도 판단). Codex Desktop 쪽에서
ambient suggestions 를 끄는 스위치는 `config.toml` 에 없어 앱 설정에서만 가능하다. 데몬 재시작
전에는 두 수정 모두 반영되지 않는다 — 커밋은 배포가 아니다.

관련: [.claude/rules/openclaw-gateway.md](.claude/rules/openclaw-gateway.md),
[.claude/rules/observed-sessions.md](.claude/rules/observed-sessions.md),
[bridge/src/hub-state-identity.ts](bridge/src/hub-state-identity.ts),
[bridge/src/codex-ambient-hooks.ts](bridge/src/codex-ambient-hooks.ts).
