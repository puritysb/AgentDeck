# 2026-07-25 — OpenClaw 세션 activity 축을 전역 상태머신에서 분리

가상 `openclaw-gateway` 세션 행이 게이트웨이는 유휴인데 "활동중"으로 표시되는
오귀속을 고쳤다. Node daemon hub는 세션 주입 시 행의 `state`를 전역
`core.stateMachine` 스냅샷에서 그대로 복사했는데, 그 상태머신은 모든 관찰
Claude/opencode hook(`daemon-server.ts`의 `/hooks/:eventName` 핸들러)이 함께
구동한다. 따라서 무관한 Claude 세션이 턴을 도는 동안 OpenClaw 행이 그
`processing`을 상속했고, 게이트웨이가 연결만 된 유휴 상태에서도 활동으로 보였다.
`projectName`/`modelName`도 같은 스냅샷을 차용해 오염 벡터였다. presence 축
(gatewayConnected 단일 술어)은 정상이었고 activity 축만 문제였다 — 진단 지문은
`/health` 전역 `state`가 `processing→disconnected`로 요동치는 동안 `gateway`는
계속 `connected`인 점이었다.

수정은 Swift daemon이 이미 쓰던 정본 패턴을 Node에 이식하는 것이다. daemon-local
`gatewaySessionState`/`gatewayModelName`을 두고 OpenClaw 어댑터 자신의 parser
이벤트로만 구동한다(`spinner_start→processing`, `idle→idle`,
`permission_prompt→awaiting_permission`, `model_info→model`; connect/disconnect에서
idle 리셋, model은 flap 간 보존). 주입은 이 전용 트래커와 `projectName:'OpenClaw'`
고정을 쓴다. 기존 `core.stateMachine` 구동은 그대로 둬서 전역 ambient 축은
불변이고 blast radius가 최소다. Swift `DaemonServer.gatewaySessionState`는 원래부터
이 패턴이라 미러 수정이 불필요했다 — Node가 뒤늦게 캐치업한 것이다.

라이브 검증: 데몬 재시작 후 `POST /hooks/UserPromptSubmit`로 전역 상태머신을
processing으로 강제해도 `ws://127.0.0.1:9120` sessions_list의 `openclaw-gateway`
행은 idle을 유지했고, Stop/SessionEnd로 전역이 disconnected로 내려가도 idle을
유지했다(수정 전에는 게이트웨이가 connected인데도 행이 전역의 "disconnected"를
미러링했다). 전체 bridge vitest 1315개 통과. 변경은 `fix/openclaw-activity-axis`
브랜치에 있으며 master 미머지·태그 없음 — 표시 전용 버그라 릴리즈 시급성이 없어
다음 `npm-v*` 릴리즈로 나간다.
