# 2026-09-09 — `daemon restart` 가 성공한 재시작을 실패로 보고한 이유

### 문제

전날 남긴 미해결 항목. `agentdeck daemon restart` 가

```
Daemon restart FAILED — no daemon with PID 27028 is answering.
```

를 찍고 exit 1 하는데, 같은 순간 9120 은 **새 빌드를 서빙하는 다른 pid** 가
정상적으로 잡고 있었다. 사용자 입장에서 자연스러운 반응은 재시도이고, 재시도는
멀쩡한 데몬을 한 번 더 죽인다.

### 원인: 자기 자신에게 보내는 SIGKILL 을 supervisor 는 실패로 읽는다

`/shutdown` 은 `exitProcessNow(0)` 으로 끝나고, 그 함수는 exit code 0 대신
**`process.kill(process.pid, 'SIGKILL')`** 을 쓴다. 시그널로 죽은 프로세스는
successful exit 이 아니다. 그래서 `daemon install` 이 깔아둔 유닛 —
launchd `KeepAlive{SuccessfulExit:false}`, systemd `Restart=on-failure`,
Scheduled Task RestartOnFailure — 이 전부 몇 초 안에 데몬을 되살린다.

2026-09-08 로그(`daemon-stderr.log`)에 전 과정이 그대로 남아 있었다:

```
14:51:37.908  Shutting down...                          ← stopDaemon
14:51:41.690  Starting daemon on port 9120...           ← launchd 재기동 (3.8초 후)
14:51:44.941  Daemon running (build 86d87e1745db)
14:51:45.130  Daemon already running on port 9120.      ← restart 가 fork 한 자식이 진 것
```

포트를 잡은 pid 13155 의 argv 는 `daemon start --foreground` — **`--no-build` 가
없다.** restart 의 자식도 `daemon start` 의 백그라운드 fork 도 항상 `--no-build`
를 붙이므로, 이 argv 를 가진 프로세스는 plist 의 `ProgramArguments` 뿐이다.
`launchctl print` 의 `runs` 카운터도 같이 올라간다.

즉 **재시작은 성공했고, 다만 우리가 fork 한 프로세스가 한 게 아니었다.**
`waitForDaemonPid` 는 자기 자식의 pid 를 기다리고 있었으므로 영원히 못 만난다.

### 고침: 판정을 혈통(pid)에서 정체(identity)로

`waitForRestartedDaemon` 이 순서대로 세 가지를 묻는다.

1. 후보 포트 중 하나에서 데몬이 응답하는가
2. 그 pid 가 **우리가 멈춘 pid 가 아닌가** — 옛 pid 비교가 실제로 하던 일이 이것이다.
   포트 응답만 보면 stop 이 조용히 실패해 그대로 살아있는 옛 데몬에게도 만족하고,
   그건 일어나지 않은 재시작을 성공이라 부르는 것이다. 이 거절은 그대로 유지했다
3. **디스크의 빌드를 서빙하는가** — "데몬이 재시작했다" 와 "내 코드가 살아있다" 는
   다른 주장이고, 둘을 갈라놓을 수 있는 건 supervisor 뿐이다(유닛은 *자기* 경로의
   `agentdeck` 을 실행하며, 그건 다른 설치본일 수 있다). 어긋나면 크게 실패한다

세 번째의 반쪽 규칙이 중요하다. **한쪽이라도 빌드를 모르면 불일치가 아니다.**
설치본에는 비교할 dist 신원이 없고 이 필드 이전의 데몬은 아무것도 안 보낸다 —
거기서 거절하면 이 함수가 없애려던 그 거짓 실패가 그대로 돌아온다.

판정은 `RestartVerdict` 로 갈라져, 실패가 *어느* 실패인지 말한다:
`stop-failed`(멈추라고 한 데몬이 아직 응답) / `stale-build`(데몬은 떴는데 다른
코드) / `no-daemon`. 성공했는데 우리 자식이 아니면 그 사실을 한 줄로 밝힌다 —
`ps` 로 재구성해야 알 수 있던 사실이고, 다음 사람이 잘 된 재시작을 또 진단하지
않게 하는 유일한 줄이다.

### 검증

같은 기계에서 launchd 가 실제로 이기는 상황을 다시 만들어 확인했다
(`launchctl kickstart` 로 유닛 소유 데몬을 복구한 뒤 restart):

```
Daemon restarted (PID 27022) on port 9120
(PID 27022 is not the process this command forked (PID 27028) — an autostart
 supervisor respawned the daemon first and won the port. It is serving build
 9affac924510.)   exit 0
```

pid 27022 < 27028 — launchd 의 재기동이 우리 자식보다 **먼저** fork 됐다.
옛 코드라면 27028 을 기다리다 실패를 찍었을 자리다.

회귀 테스트는 `waitForRestartedDaemon` 을 직접 몰아서, supervisor 재기동 수용 /
자식이 먼저 죽어도 floor 가 재기동을 기다림 / 다른 빌드 거절 / **모르는 빌드는
거절하지 않음** / 멈춘 pid 거절 / non-daemon mode 무시를 고정한다.

### 이번 변경 밖의 두 가지 (같은 SIGKILL 에서 나옴)

- supervisor 가 붙은 기계에서 `agentdeck daemon stop` 은 **멈춘 채로 있지 않는다.**
  몇 초 뒤 유닛이 되살린다
- restart 에서 **우리 자식이 이기면** 유닛의 job 은 "already running" 으로 깨끗이
  exit 0 하고, launchd 는 더 이상 그것을 되살리지 않는다 → 그 데몬은 다음 로그인까지
  **supervisor 보호 밖**이다. 실제로 이 세션 중 그 상태가 됐고(runs 카운터 정지,
  `daemon stop` 후 20초간 복귀 없음) `launchctl kickstart` 로 되돌렸다

둘 다 리포트만 하고 고치지 않았다 — 올바른 답(stop 이 유닛을 먼저 bootout 할지,
restart 가 포트를 유닛에 넘길지)은 제품 결정이다.
