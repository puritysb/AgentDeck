# 2026-07-22 — Node daemon registry self-heal + npm 1.0.2

장시간 실행 중인 Node daemon이 9121 fallback port에서 정상 동작하고 있어도
`~/.agentdeck/daemon.json`이 외부에서 삭제되면 Claude Code/Codex hook은 빈 9120으로
fallback하여 timeline 수집만 조용히 중단됐다. Swift daemon에는 이미 있던 10초
self-heal을 Node daemon에도 추가했다. 현재 PID/port의 registry는 재생성하되 다른
살아 있는 daemon의 소유권은 덮어쓰지 않고, shutdown 전에 timer를 해제해 종료 직후
파일이 되살아나는 race도 막았다. 삭제·malformed·정상 registry 회귀 테스트를 추가하고
전체 1,878 tests, typecheck, build를 통과시켰다. npm immutable version 정책에 따라
CLI/npm 타깃만 1.0.2로 진행하고 다른 1.0.1 타깃은 재배포하지 않는다.
버전 정책도 `major.minor`를 교차 타깃 호환성 계약으로, patch를 타깃별 배포
카운터로 재정의했다. 이 시점에는 root `VERSION`을 source-train ceiling으로
기록했지만, 같은 날 후속 감사에서 그 상한 제약이 독립 patch 배포와 충돌함을 확인해
위의 "패치 비순서 호환 규칙"으로 교정했다.
