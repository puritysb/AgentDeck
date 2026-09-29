# 2026-08-31 — managed PTY 정리는 capability 제거가 아니라 replacement-gated migration이다

npm 1.2.0 준비에서 `agentdeck claude|codex|opencode|monitor`를 곧 제거할
명령처럼 공지했지만, remote attach와 `--weight`의 원 구현자이자 실사용자인
@doug-w가 두 기능과 `AGENTDECK_CLAUDE_ARGS`를 모두 일상 워크플로에 사용하며,
세 가지가 사라지면 private fork를 유지해야 한다고 피드백했다. 구현 이력을 다시
대조한 결과 우려가 타당했다. remote attach는 #24의 SSH/NAT worker→main-node
same-socket 제어 제품 시나리오이고, weight는 #62의 terminal-tab→physical-deck-slot
매핑이며, agent별 args는 #93의 resume/custom-command 합성 계약이다. 셋 모두
daemon-first equivalent가 없고, 특히 args 계약은 #273의 최초 영향 표에서 누락됐다.

제품 방향은 daemon-first를 기본으로 유지한다. lifecycle의 권위도 계속 hook/event에
있고 PTY parser로 돌아가지 않는다. 대신 **workflow를 보존한 뒤 implementation을
교체**한다. remote attach는 outbound daemon worker/relay, weight는 observed session에도
적용되는 daemon-persisted pin/order, args는 lightweight non-PTY exec/profile 같은 후보를
실제 사용자 시나리오로 검증하기 전에는 managed compatibility path를 제거하지 않는다.
제거 날짜도 두지 않는다.

[Discussion #278](https://github.com/puritysb/AgentDeck/discussions/278)을 Ideas에
열어 topology/order/argument/terminal-control 요구사항을 모으고, #273은 예정된
retirement 티켓에서 replacement gate와 release checklist를 관리하는 구현 티켓으로
재작성했다. 1.2.0의 runtime/help/README/CLI/CHANGELOG/architecture/platform 문구도
`deprecated; will be removed`에서 `legacy compatibility; no removal date`로 바꾸고,
`AGENTDECK_COMMANDER_ARGS`와 agent별 `AGENTDECK_*_ARGS`를 명시적 공개 계약으로
추가했다.
