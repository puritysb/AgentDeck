# 2026-09-06 — 협업 근거층 보강: TaskCompleted 오염 분리, 세션 간 관계 이벤트, IPS10 카드 정보 복구

트라이얼 브랜치(`codex/dashboard-collaboration`)를 실제로 관찰하니 화면은 정상인데 근거가
없었다. epoch-of-tech 부모 세션(opus)은 14:16에 "매트릭스 완료 알림 대기"로 턴을 닫아 모든
표면에서 `idle`이었지만, 그 세션이 백그라운드 Bash로 띄운 `claude -p --model glm-5.3` 워커
6개는 별도 관측 세션(APME run 6개, 14:00–14:12)으로 남아 부모와 연결이 없었고, SendMessage
12건이 형제 세션과 오갔으며, 22분째 실행 중인 `run_bot_matrix.sh`는 launchd 아래로 재부모화된
채 argv에 그 세션의 스크래치패드 경로를 달고 있었다. 렌즈는 Explore 가지 하나를 그렸다.
반대로 GLM 대화형 세션(5e58fcbf)은 자식을 하나도 띄우지 않았는데 "Subagent 1~6 종료" 가지
여섯이 그려졌다 — `subagent-timeline.ts`가 `TaskCompleted`(TaskCreate 항목 완료)를
`task_completed`로 정규화해 subagent 파이프라인에 넣고 기본 라벨 "Subagent"로 떨어뜨린
결과였고, 요약문이 그 세션의 TaskUpdate 항목과 정확히 일치했다.

master 기준 새 워크트리(`feat/collaboration-lens`)에 UI 3커밋만 이식하고(baseline 2커밋은
#284/#285로 대체됨) 위에 네 가지를 얹었다. (1) 양 데몬에서 `TaskCompleted`는 `info` 주석
(`task_completed`/`team_task_completed`)이며 더 이상 자식 완료가 아니다. (2) 새 sample 이벤트
`relation`(`shared/src/sample.ts` `RelationEvent`)과 `SessionInfo.coordination`
(`CoordinationSummary`, `pnpm generate-protocol`로 Swift/Kotlin 미러 재생성):
`spawned`(프로세스 계보 / `claude -p` 실행 의도), `messaged`(SendMessage tool input +
수신측 `<cross-session-message from="uds:/…/<pid>.sock" from-name=…>` 봉투 — 소켓 basename이
송신자 pid), `waiting_on`(세션 스크래치패드 경로를 argv에 단 프로세스). 프로듀서는
`bridge/src/coordination-evidence.ts`(`CoordinationTracker`)이고 5초 자체 타이머로 돈다 —
`onRefreshed`는 관측 프로세스 집합이 바뀔 때만 발화해 백그라운드 작업 등장을 못 본다. Swift
데몬은 훅이 실어 오는 `messaged`만 생산하고 모든 종류를 렌즈로 읽는다(샌드박스에 ps 없음).
같은 프로젝트 멤버십으로는 어떤 관계도 만들지 않는다(테스트로 고정). (3) 렌즈는 관계를
"이 세션을 띄운 세션 / 띄운 세션 / 기다리는 백그라운드 작업 / 세션 간 메시지" 절로 그리고,
턴이 닫혔지만 띄운 작업이 남은 부모는 "턴 종료 · 띄운 작업 N개 결과 대기"로 표시한다.
로스터 행은 `+N`(서브에이전트) 옆에 `⧗N`(띄운 세션+백그라운드 작업)을 단다. (4) IPS10
동일 크기 카드에서 트라이얼이 300px로 올려 모든 카드에서 사라진 툴/모델/경과 게이트를
원래 값(80/64, 본문 216)으로 되돌리고 프로젝트 줄의 세션 ID 접미사를 뺐다 — 시뮬레이터
렌더로 확인(카드는 커졌는데 treemap보다 적게 보여 주고 있었다).

실측 근거 밀도(apme.sqlite, 7일): subagent 이벤트 403건 전부 claude-code, claude 태스크 294
중 69(23%)만 보유, codex 64/kiro 15/openclaw 14 태스크는 0건, 스트림 자체가 9/4 07:53 시작.
Codex는 `~/.codex/config.toml`에 SubagentStart/Stop이 있어도 0건 — 다음 측정 대상.

같은 날 저녁, "npm 없이 Swift 데몬만 쓰는 사용자도 같아야 한다"는 조건으로 두 번째 패스를
넣었다. Swift 데몬은 `messaged`만 만들고 있었는데, 부족한 것은 프로세스 표가 아니라
세션→pid 대응이었다 — 샌드박스는 `~/.claude/sessions/<pid>.json`을 못 읽고 transcript는
열려 있지 않다(실측 lsof 0). 그래서 훅 curl 세 미러 모두에 `-H "X-AgentDeck-Pid: $PPID"`를
붙였다(훅 셸의 부모가 에이전트 프로세스; Node는 migration 10, Swift 설치기는 스니펫 변경 시
자동 재작성). `CoordinationTracker.swift`는 Node 모듈의 근접 전사이고 `ProcessEnumerator.processTable()`
(sysctl, 엔타이틀먼트 없음) 위에서 5초 틱으로 돌며, 두 데몬이 `shared/coordination-evidence-vectors.json`을
재생한다. IPS10은 라운드로빈 대신 안정 로스터(`stableCardRoster`: awaiting 유지·최신순 채움·ID 정렬,
`total`→헤더 `+N`)를 양 데몬에서 받고, 카드가 coordination 센서스("대기 작업 N")를 앰버로 그린다.

검증: Vitest 262파일 4,079 통과·1 건너뜀(신규 `coordination-evidence.test.ts` 포함), IPS10
geometry host test 통과, IPS10 펌웨어 빌드 통과, macOS XCTest·Release 빌드·IPS10 OTA 결과는
아래 트라이얼 문서에 기록. 범위·사용법·복구:
[collaboration trial](experiments/collaboration/README.md), 추적 #287.
