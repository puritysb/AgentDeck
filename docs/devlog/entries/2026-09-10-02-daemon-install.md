# 2026-09-10 — `daemon install` 이 감시 밖 데몬을 유닛에 넘긴다

유닛을 등록하는 것과 유닛이 데몬을 소유하는 것은 다른 사실이다. job 의 ExecStart 는
`daemon start --foreground` 이라, 감시 밖 데몬이 이미 포트를 쥐고 있으면 job 은
incumbent 가드에 걸려 exit 0 하고 install 은 `state = not running` 위에 성공을
보고했다. `daemon stop`·`daemon restart` 가 이미 가진 구멍의 세 번째 면이고, 답도
같다 — 데몬을 유닛에 넘긴다.

`classifySupervision`(`daemon-supervisor.ts`)의 5상태 중 **행동하는 건 하나**다.
`foreign` 과 `unknown` 은 규칙상 아무것도 안 한다 — `unsupervised` 의 처방이 "데몬을
멈춘다" 이므로 "못 봤다" 를 그 판정으로 세탁하면 멀쩡한 데몬을 근거 없이 멈춘다.
`supervised` 와 `no-daemon` 은 보고만 한다(아무것도 안 바뀐 install 과 데몬을 못 띄운
install 은 다른 결과이고, 침묵으로는 구분이 안 된다).

settle 창(8초)이 필요한 이유: load 직후 job 은 포트를 서비스하려던 것이든 incumbent
에 걸려 exit 0 하려던 것이든 `state = running` 이라, 지금 한 번 읽는 건 다른 질문에
답하는 것이다. `unsupervised` 만 스스로 풀릴 수 없는 판정이라 short-circuit 한다.

**실기 확인 (2026-09-10)**. 감시 상태에서 install → `Daemon running under the launchd
unit … (PID 38363, port 9120)`, 핸드오버 없음. 그 다음 `launchctl bootout` +
`daemon start --foreground` 로 감시 밖 데몬(pid 39833, ppid 39831)을 만들고 job 을
없앤 뒤 install → 한 줄로 상태를 말하고 넘긴다:

```
A daemon is already running outside the launchd unit dev.agentdeck.daemon (PID 39833,
port 9120). The unit's job exits immediately against it, so the machine would stay
unsupervised — handing it over.
…
Daemon now running under the launchd unit dev.agentdeck.daemon (PID 40879, port 9120).
```

이후 `launchctl print` = `state = running, runs = 1, pid = 40879`, `/health` 의 pid 도
40879, 보드 20대 재접속. 포스처가 다르면 유닛의 포스처로 **바뀐다는 사실을 출력한다**
— install 은 유닛을 선언하는 명령이므로 바꾸는 건 맞지만, 조용히 바꾸면 안 된다.
