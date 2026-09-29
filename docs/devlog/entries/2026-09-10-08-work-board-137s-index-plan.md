# 2026-09-10 — 137초짜리 쿼리: 오늘 넣은 인덱스가 다른 쿼리의 플랜을 바꿨다

앞 항목의 wake 감지기를 고치고 재시작해도 `/health`가 4분간 2/19 만 답했다(false wake 는 0).
데몬은 93% CPU, `R`. `sample`은 메인 스레드 전 표본이 JS → `Builtins_CallApiCallbackGeneric` →
`sqlite3VdbeExec`: **better-sqlite3 동기 쿼리가 메인 스레드를 잡고 있었다.** 인스펙터 CPU
프로파일은 시작 ack 는 받았는데 `Profiler.stop`이 3분간 ack 되지 않음 — 루프가 분 단위로 막힌다.

### SQL 을 이름으로 잡기

프레임이 `???`라 어떤 SQL 인지 안 보였다. 인스펙터 `Runtime.evaluate` 로
`Database.prototype.prepare` 를 감싸 300ms 넘는 statement 를 `/tmp/sqlite-slow.log` 에 쓰게 했다
(동적 `import()` 는 evaluate 에서 안 되고 `process.getBuiltinModule("node:module")` 의
`createRequire` 로 우회; 루프가 굶어 ack 까지 119초). 첫 줄:

```
137802ms all SELECT t.*, r.session_id, … (SELECT COUNT(*) FROM turns tu WHERE tu.task_id = t.id …
```

**Work 판의 task 페이지 쿼리**(`listTaskPage`)다. 앱이 15초마다 부른다. `EXPLAIN QUERY PLAN` 을 뜨니
`tool_count` 서브쿼리(`COUNT(*) … WHERE se.task_id = t.id AND se.kind='tool'`)가
`SEARCH se USING INDEX idx_sevents_kind_ts (kind=?)` — task 마다 **tool 행 94,386개를 전부** 걷는다.
2,142 task × 94k ≈ 2억 행, 그것도 KB 단위 payload 행.

### 왜 오늘부터인가

`idx_sevents_kind_ts` 는 **오늘 #302 prune 워커가 나이 스캔용으로 추가한 인덱스**다. 그 전엔 그
서브쿼리에 쓸 만한 게 `idx_sevents_task(task_id, seq)` 뿐이라 빨랐다. 오늘 머지 **이전** 빌드였던
옛 데몬이 같은 증상이었던 이유도 이것 — 인덱스는 DB 파일에 있고, 내가 머지 직후 돌린
`apme prune` dry-run 이 스키마 DDL 을 실행해 **공유 DB 에 인덱스를 만들었다.** 옛 데몬의
플래너는 그 순간부터 새 인덱스를 골랐다. 바뀐 적 없는 빌드가 137초 쿼리를 돌리기 시작한 것.

### 수정과 게이트

`idx_sevents_task_kind (task_id, kind)`. 라이브 DB 에 6초 만에 생성, 같은 페이지 **137,802ms →
257ms**(recency 정렬 7ms). 게이트(`apme-work-board-plan.test.ts`)는 타이밍이 아니라 **플랜**을
고정한다 — 작은 fixture 에서 타이밍 테스트는 플랜과 무관하게 통과한다. prune 인덱스는 그대로
둔다(수정은 추가지 제거가 아님). 부수 함정: 스키마 DDL 은 JS 템플릿 리터럴 안이라 SQL 주석에
백틱을 쓰면 리터럴이 끊긴다 — 첫 판이 그렇게 빨개졌다.

### 운영 규칙 둘

인덱스를 추가할 땐 그 테이블의 다른 핫 쿼리에 `EXPLAIN QUERY PLAN` 을 먼저 댄다. 데몬이 CPU 를
쓰면서 답을 안 하면 JS 보다 **SQL 을 먼저** 본다 — `sample` 의 `sqlite3VdbeExec`, 그리고 prepare
래퍼.
