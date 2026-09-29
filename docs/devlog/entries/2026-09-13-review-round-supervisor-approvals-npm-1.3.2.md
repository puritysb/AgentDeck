# 2026-09-13 — 1.3.0 델타 적대적 리뷰: 수퍼바이저 프로브와 승인 생존자, npm 1.3.2

#318을 머지한 뒤 1.3.0 델타에서 새로 생긴 모듈부터 적대적 리뷰를 돌렸다
(`daemon-supervisor.ts`, 플러그인 승인 경로). 10건이 나왔고 전부 소스로 검증한 뒤
실재하는 것만 고쳐 PR #319로 머지했다. 머지 직전에 다른 세션이 `npm-v1.3.1`을
`7f479906`에 찍고 퍼블리시한 상태라 세 수정은 1.3.1에 없다 — 그래서 1.3.2를 잘랐다.
Apple·Android·Stream Deck·Ulanzi·ESP32는 움직이지 않는다.

## 프로브가 안 보고도 "죽었다"고 답했다

`supervisorJobRunning`의 자기 주석이 규칙을 적어 두었다 — `undefined`는 "답을 못
받았다"이지 "죽었다"가 아니며 호출자는 상한까지 기다린다. 세 프로브가 각자 어겼다.

- `schtasks`는 헤더뿐 아니라 **상태 값도 현지화**한다. `/^Status:\s+Running/`는
  한국어 Windows에서 실행 중인 작업을 못 맞추고 `false`를 답했다 →
  `convergeInstalledSupervision`이 멀쩡한 수퍼바이즈드 데몬을 멈춰 "인계"하고,
  `waitForRestartedDaemon`의 180초 상한이 20초 하한으로 접혀 거짓 실패 보고.
- launchd `catch`는 모든 `execFileSync` 실패에 `false`. 주석은 bootout 경우만
  정당화하는데 재시작 부하 중 5초 타임아웃도 같은 가지를 탄다. 실제로 실행되고
  0이 아닌 코드로 끝난 명령만 숫자 `status`를 가진다 — 그게 "답했다"의 기준이다.
- systemd는 `active` 외 전부를 죽음으로 읽었다. `Restart=on-failure` 백오프 중인
  유닛은 `activating`을 답한다.
- `supervisorPosture`는 못 읽으면 `[]`를 답했다. "기본 posture를 굽는다"로 읽힌다.
  Windows 예약 작업은 XML을 `schtasks /Create` 뒤 지우므로 unit 파일이 아예 없고,
  `--local` 머신의 모든 `daemon restart`가 상속한 `--local`을 날조된 기본값과
  비교해 posture-mismatch 가지를 타고, 작업에 대해 사실이 아닌 문장을 찍고,
  **비수퍼바이즈드 데몬을 포크**했다. `routeDaemonLifecycle`이 이미 `undefined`를
  "비교할 것 없음"으로 모델링하고 있어 넘겨주는 것이 수정의 전부다.

`unknown`이 어디에 떨어지는지 소비자까지 따라갔다. `classifySupervision`은 명시적
`'unknown'` 분기로 돌아가고, `supervisorLivenessProbe`는 unknown을 생존으로 읽되
180초 상한이 대기를 끝낸다. 무한 대기·오탈취 경로는 없다.

## 승인 하나를 닫으면 다른 하나가 안 보였다

exec 승인과 플러그인 승인은 독립 큐이고 데크는 한 번에 하나만 그린다.
`activePendingApproval`의 주석은 "보이던 것이 닫히는 순간 대기 중이던 것이 자동으로
떠오른다"고 약속했다. 행 필드는 그랬다. **상태는 아니었다.** 모든 종료 경로가
`spinner_start`/`idle`을 무조건 냈고 데몬이 그걸 그대로 `gatewaySessionState`에
매핑해서, 살아 있는 승인이 남아 있어도 행이 `awaiting_permission`을 벗어났다.
`sessionTier`가 `attention`을 멈추고 어떤 표면도 PERM을 그리지 않는다 —
사용자는 한가한 데크를 보고 에이전트는 계속 막혀 있다. 기존 공존 테스트가
`getPendingApproval()`만 단언했던 것이 이 버그가 출시된 이유다.

`settleApprovalActivity`가 셋째 경우를 제자리에 놓는다: 생존자가 있으면 재방송(상태
복구와 질문 교체를 한 번에), 큐가 비었을 때만 processing/idle로 정착. 같은 리뷰에서
둘 더 — 두 번째 플러그인 승인이 첫 번째를 조용히 버리던 것(독립 플러그인·cron에서
오므로 실제로 겹친다; 버려진 쪽은 Gateway에 pending으로 남고 어떤 표면에서도 답할
수 없다), `exec.approval.list` 실패가 한 `await` 체인 때문에 플러그인 캐치업을
통째로 건너뛰던 것.

Swift 데몬은 같은 버그에 `gatewayPendingApproval = nil`까지 무조건이라 생존자가
행마저 잃었다. `survivingApprovalPrompt()`로 같은 모양을 맞췄고 `xcodebuild`로
빌드·853 테스트를 돌렸다. 남은 사소한 비대칭 하나: survivor 분기에서
`gatewayCurrentTool`을 nil로 두는데 `gateway_approval` 경로는 `command`의 첫
토큰을 채운다. 표시용이라 이번 컷에 넣지 않았다.

## master의 기존 실패

`CollaborationFeedTests.testRenderCollaborationHistoryAtRailWidth`
("InvalidTransition")가 손대지 않은 `origin/master`에서도 로컬 재현된다. CI
`test-macos`는 통과하므로 환경 의존이다. 이 컷과 무관하며 더 파지 않았다.

## 컷

새 테스트는 전부 변이 검증했다 — 각 수정을 되돌리면 빨개진다. 머지된 master
(`62b5a117`)에서 4,483 통과 / 1 skip. 1.3.1과 같은 절차: 네 public 매니페스트,
`daemon.ts`의 `--version`, portable-reader 픽스처를 1.3.2로 올리고
`npm-v1.3.2` 태그로 CI 퍼블리시.
