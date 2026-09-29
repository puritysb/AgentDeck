# 2026-08-14 — Stop 유실률 계측(`end_source`) + 관측세션 missed-Stop 복구

### 문제

1.0.20 효과를 실측하려다 **측정 자체가 불가능**하다는 걸 먼저 확인했다. 세 겹이었다.

- 수정 커밋(04e2c71c)은 05:55, npm 게시는 05:57 — 배포 후 20분.
- 9120 을 잡고 있던 데몬은 8/13 22:28 에 뜬 **1.0.19 빌드**(메인 repo `bridge/dist`
  = 8/13 00:03, `claude-turn-watchdog.js` 부재)였다.
- 결정적으로, **1.0.20 의 missed-Stop 워치독은 `bridge/src/index.ts` 의 managed PTY
  세션에만 배선돼 있었다.** apme.sqlite 의 Claude run 은 session_id 가 전부 bare uuid
  = hook-observed(터미널에서 직접 `claude`, 데몬 `/hooks/` 경유)라서, 데몬을 새로
  빌드해 올려도 기준선 22턴 중 **한 턴도** 복구 대상이 아니었다.

기준선을 뽑아보니 원인 분해도 안 됐다. claude-code 22턴 중 응답 NULL/EMPTY 11건인데,
그 안에 Stop 유실 / 사용자 Esc 중단 / 4초짜리 재입력 no-op 턴이 섞여 있고 행 모양이
전부 같았다. 턴 길이도 못 쓸 상태였다 — `ended_at` 이 *다음 프롬프트* 시각이라
19353s·15233s·5729s 짜리 "턴"이 실제로는 대부분 사용자 유휴 시간이었다.

### 해결

**`turns.end_source`** — 어느 신호가 그 턴을 닫았는지 행마다 기록. `stop` /
`synthetic_stop`(워치독 복구 = 유실 측정치) / `next_prompt`(미복구 유실) /
`session_end` / `run_close` / `clear`. `agentdeck apme stop-health --since 7d
[--agent]` 로 조회. 같은 커밋에서 턴을 **Stop 시점에** 닫도록 변경.

**`bridge/src/observed-turn-watchdogs.ts`** — 관측 세션용 missed-Stop 복구. 데몬
1프로세스가 session_id 로 다중화하므로 세션당 워치독 1개. 복구는 데몬이 자기 loopback
`/hooks/Stop` 으로 self-POST.

### 핵심 설계 결정

- **도입 이전 행은 backfill 하지 않는다.** 당시엔 전부 다음 프롬프트에 닫혔으므로 Stop
  도착 여부를 구분할 근거가 없다. 추측 backfill 은 이 컬럼이 재려는 바로 그 비율을
  오염시킨다. `stop-health` 는 그 행들을 `?` 로 따로 센다.
- **비율의 분모는 판정 가능한 턴만**(`stop + synthetic_stop + next_prompt`). 단
  `total` 에는 **열린 턴을 포함**한다 — 열린 턴이야말로 "아직 안 온 Stop" 이라
  분모에서 빼면 측정하려는 실패를 숨기게 된다.
- **복구는 원래 경로와 같은 경로여야 한다.** Stop 분기는 상태머신·타임라인·APME
  응답+턴닫기·모델복구·스티어링·liveness 6가지를 한다. 두 번째 사본은 반드시
  드리프트하므로 self-POST 로 재진입한다.
- **synthetic Stop 은 리스너가 필요한 큐를 비우면 안 된다.** Stop 응답은 덱
  디렉티브를 `takeDirective` 로 **꺼내서** 돌려준다 — 전달 방식이 "Claude 가 기다리는
  hook 을 block 하고 continuation reason 으로 주는 것"이기 때문이다. self-POST 응답은
  아무도 듣지 않으므로 그대로 뒀다면 사용자 후속 지시가 에러도 흔적도 없이 증발했다.
  `takeDirectiveForStop` 가드를 **큐 옆에** 뒀다 — 규칙은 호출부가 아니라 큐에 속하고,
  앞으로 큐를 비우는 누구든 같은 검사를 져야 한다.
- **식은 세션은 수거해야 한다.** 관측 세션은 죽을 때 SessionEnd 를 안 보낸다(터미널
  닫힘, 슬립). 무장 상태 워치독의 5초 폴링이 데몬 수명 내내 남으므로 기존 60초 tick 에
  sweep 을 얹고(타이머 신설 없음) 세션 수 상한을 뒀다.

### 검증

- vitest 184 파일 2968 통과, `pnpm docs:check` 통과.
- 실 transcript 5개로 프로브 확인 — 4개는 `assistant`/`end_turn` 복구 대상, user
  레코드로 끝난 1개는 발화 안 함. 턴 시작보다 이전 `end_turn`(직전 턴 레코드) 대조군 0회.
- 820MB 라이브 DB 사본에 마이그레이션 적용 — 기존 1997 claude 턴이 전부
  `preInstrument` 로, 어느 버킷으로도 새지 않음.
- **실행 중인 데몬 대상 e2e**: 가짜 관측 세션 3개로 `stop` / `next_prompt` /
  `synthetic_stop` 3신호 모두 재현, synthetic 케이스는 transcript 에서 응답까지 캡처
  (이전이면 `response NULL`). 검증 후 해당 run 3건은 자식 행까지 삭제.

---
