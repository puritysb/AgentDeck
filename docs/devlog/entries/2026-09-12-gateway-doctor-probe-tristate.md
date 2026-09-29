# 2026-09-12 — doctor 프로브가 양쪽으로 오답이었고, 30초마다 돌고 있었다

AgentDeck에서 OpenClaw가 비정상으로 보이거나 일부 기기에서 아예 안 뜬다는 증상을
추적했다. 게이트웨이는 정상이었다 — 단일 PID로 연속 가동, `openclaw doctor` exit 0,
crash-loop 기록 1건(9월 1일). 흔들린 것은 그것을 재는 계측층이다.

`checkGatewayHealth`는 Node 데몬에서 OpenClaw 행을 빨갛게 만드는 유일한 입력인데,
boolean 하나로 답하면서 두 갈래를 **모두** 오답으로 접고 있었다.

- `ENOENT`(PATH에 `openclaw` 없음) → `false` = "정상". 한 번도 접촉하지 못한
  게이트웨이를 이상 없음으로 보고한다. CLI가 `~/.openclaw/bin`에만 있고
  `/opt/homebrew/bin`에는 없는 설치에서 그대로 재현된다.
- 타임아웃 → `true` = "고장". `execFile`이 `DOCTOR_TIMEOUT`에 자식을 죽이는데,
  느린 doctor 실행은 실패한 게이트웨이가 아니다.

둘 다 "볼 수 없었다"이고, 이제 둘 다 `known: false`로 돌려 호출부가 직전 값을
유지한다. health frame 경로의 `resolveGatewayHealth`가 이미 쓰던 계약과 같다.
완료된 실행만 exit code로 `hasError`를 정하고, 전이는 로그를 남긴다.

주기가 나머지 절반이었다. 살아 있는 게이트웨이 상대 실측으로 `openclaw doctor`는
**8~9초**다. 30초 주기면 CLI가 시간의 30%를 떠 있고, 실행마다 자기 연결을 연다.
게이트웨이 로그 4일치에서 이 검사 하나가 `channels.status` **9,958건 · 고유 연결
9,958개 · 전체 게이트웨이 RPC의 99.5%**를 차지했다. 평균 441ms, p99 740ms인데
소켓을 공유하는 `sessions.list`·`models.list`는 50~200ms다. 기본 주기를 OpenClaw
자체 health-monitor와 같은 300초로 맞추고, 천장은 15초에서 30초로 올렸다.

⚠️ 소스에 `channels.status` 문자열은 없다. `doctor`를 통해 간접 호출하므로 grep으로
잡히지 않는다. 폴러를 못 찾겠으면 CLI를 경유하는 경로를 의심할 것.

⚠️ **빨간 행의 원인이 이 프로브만은 아니었다.** 같은 날 OpenClaw 쪽에서 별개 원인을
찾았다 — 맥 앱이 로컬 디바이스 식별정보 파일 충돌(`Legacy device identity sources
conflict`)로 노드 등록에 실패하고 있었고, 대시보드 노드 패널이 빨간 건 그쪽이다.
계측을 고쳤다고 피계측 대상의 고장이 사라지는 것은 아니므로 두 가지를 합쳐 읽지 말 것.

회귀 테스트는 `bridge/src/__tests__/gateway-probe-verdict.test.ts` 6케이스다
(정상 종료·비정상 종료·ENOENT·시그널 kill·spawn 실패·미지 판정 시 값 유지).
npm 1.3.1로 컷했다.
