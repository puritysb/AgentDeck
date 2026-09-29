# 2026-09-09 — 데몬 lifecycle 은 supervisor 를 통과한다 (stop/restart 잔여 두 가지)

앞 항목에서 `daemon restart` 의 **판정**은 고쳤지만, 그 판정을 필요하게 만든 자기
SIGKILL 의 부작용 둘은 남겨뒀다. 이번에 그 둘을 닫는다.

1. supervisor 가 붙은 기계에서 `agentdeck daemon stop` 이 멈춘 채로 있지 않는다
2. restart 에서 CLI 자식이 포트를 이기면 유닛 job 은 `exit 0` 하고, 그 데몬은 다음
   로그인까지 supervisor 밖이다

### 먼저 근거: SIGKILL 을 바꾸면 되는가 — 아니다

일회용 LaunchAgent 에 배포본과 같은 `KeepAlive{SuccessfulExit:false}` 를 달고 실측
(2026-09-09):

| 종료 방식 | launchd 반응 | 관측 |
| --- | --- | --- |
| `kill -9 $$` | 매번 재기동, ~7초 간격 (minimum runtime 10s) | `runs` 2→3→4 |
| `exit 0` | 재기동 없음 | `state = not running`, `last exit code = 0` |

전제는 확인됐다. 그런데 `exitProcessNow` 를 `exit 0` 으로 바꾸는 건 두 번 틀린다.

- SIGKILL 은 이유가 있어서 거기 있다 — `process.exit()` 가 macOS serial fs worker
  join 에 걸려 pid 가 남은 실측이 있다(2026-06-06 항목). 9120 을 쥔 채 죽지 않는
  데몬은 되살아나는 데몬보다 나쁘다
- 그리고 **증상 2 를 고치지 못한다.** clean exit 이면 launchd 는 *의도적으로*
  재기동하지 않는다 → CLI 자식이 매번 이기고, 데몬은 경합이 아니라 결정적으로
  supervisor 밖에 남는다

종료 코드는 크래시 여부를 나르는 1비트 채널이고 "사용자가 시켰다" 를 넣을 자리가
없다. 그래서 의도는 종료 코드가 아니라 **supervisor 에게 직접** 말한다.

### 고침: `stop` / `start` / `restart` 가 유닛을 구동한다

`bridge/src/daemon-supervisor.ts` — 계획(plan)은 순수 함수, 실행만 프로세스를 만진다.

- **macOS 는 비대칭.** `launchctl stop` 은 SIGTERM 만 보내고 그 핸들러는 결국 같은
  self-SIGKILL 로 끝나므로 KeepAlive 가 되살린다. 멈춘 채로 있는 stop 은 `bootout`
  뿐이다. `bootout` ≠ `disable` — plist 는 남고 다음 로그인에 다시 로드된다. 이건
  `systemctl --user stop` / `schtasks /End` 이 이미 뜻하던 것과 같은 의미다.
  대가: bootout 뒤 `kickstart` 는 rc 113 `Could not find service` (실측) → start 는
  `bootstrap` 을 먼저 한다
- **`--foreground` 는 라우팅하지 않는다** — 그 철자가 유닛의 `ExecStart` 다
- **유닛이 표현 못 하는 요청은 되가져온다**: `-p/-d/--local/--loopback/--port-window/
  --wake-word` 는 유닛의 고정 argv 로 만들 수 없다 → 예전처럼 fork 하고, **그 데몬이
  supervisor 밖이라고 말한다**
- **posture 불일치도 되가져온다** — 유닛 파일에서 실제 posture 를 파싱해
  (`parseSupervisorPosture`) 상속하려는 posture 와 비교한다. 담지 않은 유닛에 맡기면
  loopback-only 데몬이 광고하는 데몬이 된다(상속이 막으려던 enterprise downgrade)
- **stop 은 라우팅과 무관하게 유닛도 멈춘다** — 안 그러면 옛 데몬이 새 데몬 한가운데로
  되살아난다
- 판정은 `routeDaemonLifecycle` 한 곳(`supervisor` / `one-off-flags` /
  `posture-mismatch` / `no-supervisor`). 두 호출부(`start`/`restart`)가 같은 질문에
  다르게 답하면 안 되고, 호출부에 흩어 쓴 규칙은 한쪽이 잊어도 초록으로 남는다
- `waitForRestartedDaemon` 의 `isChildAlive` 자리에는 **유닛의 잡이 도는가**
  (`supervisorLivenessProbe`, 2초 캐시)가 들어간다. 없으면 floor(20s)가 하드
  데드라인이 되어 stand-down 협상 중인 정상 기동을 실패로 보고한다 — 앞 항목이
  없앤 바로 그 거짓 실패다. **모르는 답은 "죽었다" 가 아니라 "계속 기다린다"**

### 검증 (실기, 이 머신)

바꾸기 전 상태가 정확히 증상 2였다: `runs = 7, last exit code = 0,
state = not running` 인 유닛 옆에서 ppid 1 짜리 CLI 자식(pid 52867)이 9120 을 서빙.

```
$ agentdeck daemon restart
Stopped the launchd unit dev.agentdeck.daemon (it will start again at the next
login, or on 'agentdeck daemon start').
Restarting through the launchd unit dev.agentdeck.daemon.
Daemon restarted (PID 90566) on port 9120
(PID 90566 is the launchd unit dev.agentdeck.daemon's own process — it stays
 supervised.)
$ launchctl print gui/501/dev.agentdeck.daemon | grep -E 'state|pid'
	state = running
	pid = 90566
```

- `daemon stop` 뒤 **30초 동안 재기동 없음**(이전 ~7초), `launchctl print` 는
  `Could not find service`
- `daemon start` 는 bootout 된 잡을 bootstrap 해서 다시 유닛 아래로 띄웠다
  (`Daemon started (PID 83653, …) under the launchd unit …`)
- 재시작 후 `/health` 의 build 가 디스크 해시와 일치, serial 11 보드 · Gateway ·
  Pixoo · iDotMatrix · Stream Deck · D200H · ADB 전부 복귀

회귀 테스트 `bridge/src/__tests__/daemon-supervisor.test.ts` (26개): plan 고정
(launchd 는 `bootout`, `stop` 이 아니다 / bootstrap→kickstart 순서 / optional 극성),
라우팅 진리표, `runSupervisorPlan` 의 optional-실패 vs required-실패, 그리고 **posture
파서를 세 설치기의 실제 산출물에 걸어** 확인한다 — `buildPlist` / `buildUnitFile` /
`buildScheduledTaskXml`. 이 교차 검증이 실제로 결함을 잡았다: Task Scheduler XML 은
마지막 플래그 뒤에 공백이 아니라 `<` 가 오므로, 파서에 맞춰 손으로 지어낸 fixture 라면
영원히 통과했을 정규식이 실패했다.

### 남은 것

- `daemon install` 은 유닛을 로드만 하므로, 이미 도는 (감시 밖) 데몬이 있으면 유닛의
  잡이 incumbent 가드에 걸려 `exit 0` 하고 `state = not running` 이 된다. 즉 install
  직후에도 감시 밖일 수 있다 — 지금 수렴시키는 건 `daemon restart` 다
- 부작용 하나가 커진다: stop 이 진짜로 멈춘 채 있으므로, 그 사이 macOS 앱이 자기
  in-process Swift 데몬으로 승격할 창이 넓어진다. 그 다음 `daemon start` 는
  stand-down 을 요청하고 — **stand-down 당한 앱이 스스로 클라이언트로 복귀하지 못하는
  기존 버그**(memory `daemon-restart-wedges-installed-macos-app`, 9/7·9/9 재현)에
  닿는다. 이번 세션에도 앱은 9120 에 CLOSED 소켓 4개만 남기고 ESTABLISHED 0 이었다.
  별건이며 미해결

---
