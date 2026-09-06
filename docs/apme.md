---
id: arch.apme
title: APME Evaluation Module
description: Agent Performance Monitoring and Evaluation — sample schema, collector, judges, scorecard, recommender, daemon API.
category: Engineering
locale: en
canonical: true
status: stable
owner: APME maintainers
reviewed: 2026-07-21
revision: 2026-07-21
source_of_truth: docs/apme.md
validators: [pnpm test]
---
# APME — Agent Performance Monitoring & Evaluation

에이전트 세션(Claude Code, OpenClaw, OpenCode, Codex CLI)의 작업 결과를 **데이터셋화**하고, 결정론적 검증 + LLM judge로 **자동 평가**하며, 사용자 피드백(vibe check)을 함께 축적하는 모듈. 그 피드백으로 루브릭을 자동 튜닝하는 층은 설계만 있고 아직 구현되지 않았다 — 아래 **Rubric auto-tuning** 절 참고.

평가는 **카테고리별로 방법이 다르다** — 코딩 태스크는 run-level + git diff + 결정론 레이어, 비코딩 태스크는 turn-level + judge only. 모든 데이터는 `~/.agentdeck/apme.sqlite`에 저장되고, daemon HTTP API + WS 프로토콜로 Apple/Android/Stream Deck/ESP32 UI에 실시간 노출된다.

**비용 정책**: 기본 judge 체인은 **로컬 MLX 서버 → 온디바이스 Apple Intelligence Foundation Models** 다. 둘 다 무료·로컬이고, 순서는 **실측한 판정 품질 순서**다 — 아래 [기본 judge 백엔드](#기본-judge-백엔드는-왜-mlx-foundation-models-순서인가) 참고. 유료 백엔드(`api`, OpenRouter 계열 `openai`)는 사용자가 명시할 때만 선택된다. 모든 run 을 평가해도 비용이 0 이 되도록 설계.

### 기본 judge 백엔드는 왜 MLX → Foundation Models 순서인가

2026-08-22 실측(`OpenClaw/model-eval`, `judging` 분류 6 시나리오 × 3 반복, 결과는 <https://eval.foundby.kr>):

| 백엔드 | judge-fidelity 루브릭 | 무너지는 지점 |
|---|---|---|
| Apple FM (온디바이스, 이전 기본값) | **0.580** | 실패한 런에 후한 점수, 무결함 diff 에 결함 발명, diff·번역 입력 15회 `unsupportedLanguageOrLocale` 거부 |
| MLX MoE (Qwen3.6-35B-A3B) | 0.86 | 장문 입력에서 JSON 을 닫지 못하고 잘림(= 판정 행 유실) |
| MLX dense (Qwen3.8-27B) | 1.00 | — |

두 번째 축은 컨텍스트다. FM 창은 **하드 4,096 토큰**이고(초과 시 `exceededContextWindowSize` 로 즉시 거부하며 센 토큰 수를 알려준다), 이 기계의 실제 `task_rollup` 판정 프롬프트 1,294건을 재구성해 애플 토크나이저로 재보니 **4.2% 가 그 창을 넘는다**(p90 2,968 · p99 7,371 · 최대 12,336 토큰). 넘는 순간 판정은 실패하고, 넘지 않으면 방향이 틀린 점수가 그대로 DB 에 적힌다 — 후자가 더 나쁘다.

그래서 기본값을 뒤집되 **FM 을 바닥으로 남긴다**: MLX 서버가 없는 기계(App Store 단독 설치 포함)는 예전과 똑같이 온디바이스로 평가된다. 기능이 사라지지 않는다.

**폴백은 기본값에만 붙는다.** 사용자가 `judge.backend` 를 직접 적었는데 그 서버가 꺼져 있으면 조용히 약한 판정자로 내려가지 않고 **평가를 건너뛴다**(눈에 보이는 실패). `judge.fallbackToFoundationModels` 를 명시하면 되살릴 수 있다.

REVIEW 는 판정 전에 **실제로 답할 백엔드를 먼저 확정한다**(`resolveJudgeBackend` / Swift `ReviewRunner.resolveBackend`). 두 다리의 창이 4배 차이라 diff·궤적 예산을 설정값이 아니라 실행될 다리 기준으로 잡아야 한다. 같은 실측에서 basic 티어(=FM 전용 티어)의 기존 상한 조합이 창을 26% 초과하는 프롬프트를 만들 수 있다는 것도 드러나 상한을 실측값 기준으로 줄였다(diff 12KB → 5KB, 활동 4,000자 → 1,200자, Swift 궤적 6,000자 → 3,000자).

> **관련 문서**
> - [why-apme.md](./why-apme.md) — 왜 APME를 만들었는가 (설계 의도, 카테고리별 평가 전략)
> - [apme-pipeline.md](./apme-pipeline.md) — 8 레이어 파이프라인 심층 해설 (file:line 앵커 포함)

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Agent Sessions                                │
│  claude-code (hooks)  │ openclaw/opencode (GW)  │ codex-cli (hooks)  │
└───────┬───────────────┴────────┬─────────────────┴──────┬────────────┘
        │ hook POST              │ timeline events        │ hook POST +
        │ + transcript JSONL     │                        │ notify + rollout
        ▼                        ▼                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│  wireAgentApme() / claudeHookToSpans  (bridge/src/index.ts)          │
│  3경로 수렴 → ApmeCollector 공통 API                                   │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Collector  (bridge/src/apme/collector.ts)                           │
│  openRun → ingestHook → setTurnResponse → closeTurn → closeRun       │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  SQLite Store  (~/.agentdeck/apme.sqlite)                            │
│  runs │ turns │ steps │ artifacts │ evals │ rubrics │ vibe_feedback  │
│  + v_run_metrics, v_model_scorecard, v_category_scorecard            │
└──────┬────────────────┬──────────────────┬──────────────┬────────────┘
       │                │                  │              │
       ▼                ▼                  ▼              ▼
  ┌─────────┐    ┌──────────────┐   ┌────────────┐  ┌────────────┐
  │Classifier│   │   Runner     │   │Tuner(미구현)│  │Recommender │
  │rules+MLX │   │ det+judge    │   │ OPRO loop  │  │ scorecard  │
  │10 cats   │   │ category-    │   │ 설계만 존재 │  │ cost/qual  │
  │          │   │ aware        │   │            │  │            │
  └─────────┘    └──────┬───────┘   └────────────┘  └────────────┘
                        │
                        ▼
  ┌────────────────────────────────────────────────────────────────┐
  │  Daemon 30s Loop + HTTP /apme/* + WS apme_eval broadcast        │
  │  → BridgeTimeline `eval_result` entries                         │
  │  → Apple / Android / Stream Deck / ESP32 / TUI dashboard        │
  └────────────────────────────────────────────────────────────────┘
```

## Execution model

APME는 **수집**과 **평가**를 분리한다:

- **Deprecated session bridge** (`agentdeck claude/codex/opencode/monitor`): 호환성 유예 기간 동안 세션 시작~종료의 runs, turns, steps, usage, git diff artifact 를 SQLite에 기록. 세션 종료 시 eval 은 실행하지 않음 (프로세스가 2초 내 exit). 제거 계획은 #273.
- **Daemon** (`agentdeck daemon start`): 30초마다 복구 루프를 돈다 — 미평가 run을 eval 큐에 넣고, 10초 이상 닫힌 run의 outcome을 계산하고, `task_category IS NULL` run을 재분류하고, orphan run을 태깅. 장수 프로세스이므로 deterministic (lint/build/test) + LLM judge 를 여유롭게 실행.
- **Turn-level 즉시 평가** (runner 내부): 비코딩 카테고리는 턴 완료 직후 daemon 없이도 judge 호출 — conversation/planning/research/review 세션은 실시간 피드백 루프.
- **Task-level 즉시 평가** (runner 내부): `TodoWrite all-completed` 나 `/clear` 등 task 경계 신호가 감지되면, 해당 태스크에 속한 여러 턴을 모아 `task_rollup` 루브릭으로 즉시 평가.

daemon 없이 session bridge 단독 사용 시 데이터만 축적되고 coding eval 은 daemon 기동 후 자동 처리된다. Turn/Task-level eval은 세션 중에도 작동한다.

## File map

| File | Role |
|---|---|
| `bridge/src/apme/types.ts` | DB row TS types (Run, Turn, Step, Eval, Rubric, Vibe, Scorecard, TaskSignals) |
| `bridge/src/apme/store.ts` | SQLite DAO — DDL, CRUD, 집계 뷰 3종, 기본 + 카테고리별 루브릭 seed |
| `bridge/src/apme/settings.ts` | `~/.agentdeck/settings.json` 병합 로더 + `shouldJudge()` gate |
| `bridge/src/apme/collector.ts` | 수집 경계 — session/turn lifecycle, hook → steps, transcript/rollout response → turns |
| `bridge/src/apme/classifier.ts` | Task signals 계산 + rule-based + MLX fallback 분류 |
| `bridge/src/apme/runner.ts` | Run-level (coding) + turn-level (non-coding) 평가 파이프라인 |
| `bridge/src/foundation-models-helper.ts` | CLI-only Foundation Models Swift helper resolver / JSONL process manager |
| `bridge/fm-helper/AgentDeckFMHelper.swift` | macOS 26+ Swift helper source bundled with the CLI package |
| `bridge/src/apme/outcome.ts` | Outcome 판정 (committed/iterated/abandoned 등) + composite score |
| `bridge/src/apme/recommend.ts` | 모델 추천 — scorecard 기반 |
| `bridge/src/apme/hw-sampler.ts` | macOS HW 스냅샷 — `vm_stat`, `sysctl`, `uptime` |
| `bridge/src/apme/http.ts` | Daemon HTTP routes (`/apme/*`) |
| `bridge/src/apme/index.ts` | 모듈 초기화 + re-export (`initApme()`) |
| `shared/src/protocol.ts` | WS 프로토콜 — `ApmeEvalEvent`, `ApmeScorecardEvent`, `ApmeRecommendationEvent` |

## Data schema

### runs — 한 세션 = 한 run

```
id, session_id, agent_type, model_id, project_name, project_path,
task_prompt, started_at, ended_at,
input_tokens, output_tokens, cost_usd, exit_code,
git_before, git_after, parent_run_id, hw_profile,
task_signals, task_category, task_category_source,
outcome, outcome_confidence,
efficiency_json, composite_score
```

- `task_prompt`는 첫 `UserPromptSubmit` 훅/이벤트에서 lazily capture
- `git_before`/`git_after`는 `git rev-parse HEAD`
- `task_signals` — classifier가 계산한 툴 히스토그램/지표의 JSON
- `task_category` — 10개 카테고리 중 하나, `task_category_source` 는 `'rule' | 'llm' | 'auto'`
- `outcome` — `committed | iterated | exploratory | abandoned | interrupted | ab_winner | ab_loser | pending`
- `composite_score` — 4차원 가중합 (outcome + judge + efficiency + vibe)
- `parent_run_id` — `/clear` 로 갈라진 직전 run. `/clear` 는 컨텍스트를 리셋할 뿐 사용자의 작업을 끝내지 않으므로, 이 엣지가 없으면 한 대화가 서로 끊긴 N개의 run 으로 흩어진다 (실제로 한 세션에 127 run 관측). 진짜 세션 시작이면 NULL

### 그래프 투영 — 행 저장소를 property graph 로 보기

`runs → tasks → turns → sample_events` 는 실제 FK 를 가진 containment tree 라 그대로 그래프가 된다. 하지만 **작업 단위끼리 이어주는 간선**(공통 조상이 없는 두 task 의 연결)은 컬럼에 문자열로 눌려 있었다. 그래서:

- **스키마로 고친 것** — `sample_events.turn_id`(기존엔 run 안에서만 유일한 `turn_index` 뿐이라 event→turn 엣지가 아예 없었음), `runs.parent_run_id`(위 참고). 둘 다 마이그레이션에서 backfill.
- **투영으로 유도하는 것** — session / project / model / agent / tool / subagent / file 은 행이 아니라 컬럼·payload 이므로 그래프 빌더가 노드로 materialize 한다. subagent 는 census 가 부모 task 의 sample 에 쓴 lifecycle event 에서 나오며 `delegated` 엣지로 연결된다. 특히 **file 노드**는 tool payload 의 `file_path` 에서 뽑아 run 의 `project_path` 기준 상대경로로 키잉하므로, 같은 파일을 worktree 와 본 체크아웃에서 만졌어도 한 노드로 합쳐진다. 커버리지는 부분적이다(경로를 받지 않는 Bash/WebFetch 등) — `stats.fileCoverage` 가 그 비율을 그대로 보고한다.

모델 정의는 `shared/src/apme-graph.ts`(SSOT), 빌더는 Node `bridge/src/apme/graph.ts`와 Swift `ApmeGraphProjection.swift`, 노출은 양 데몬의 `GET /apme/graph`, 뷰어는 대시보드 **Graph** 탭(외부 라이브러리 없이 canvas force layout — 대시보드는 self-contained HTML 이라 CDN 을 못 쓴다).

투영은 파생물이며 저장하지 않는다 — 마이그레이션 없이 형태를 바꿀 수 있다.

### turns — 멀티턴 세션의 개별 턴

```
id, run_id, turn_index, prompt, response,
started_at, ended_at, tool_calls,
files_modified, files_created,
git_before, git_after,
task_category, outcome, composite_score, efficiency_json,
end_source
```

턴은 `UserPromptSubmit`/`chat_start`/`user_prompt` 이벤트마다 생성되고, 응답 캡처 시 `response` 채워짐. **닫히는 시점은 Stop** (`collector.noteTurnStop()`) — 다음 프롬프트가 아니다. 이전에는 `ended_at` 이 다음 프롬프트 시각이었으므로 턴 길이에 사용자가 다음 지시를 타이핑한 시간이 통째로 섞였고(실측: 5h 턴 = 대부분 유휴), duration 파생 효율 지표가 전부 오염돼 있었다.

#### 판정 대상 선별 — 에이전트의 작업이 없으면 판정도 없다 (2026-09-03)

task rollup judge 는 텍스트가 있으면 무엇이든 채점했고, 그 "텍스트"에 사용자 프롬프트가
포함됐다. 실측(한 주): 채점된 182건 중 **69건은 에이전트 응답이 하나도 없었고**(평균
0.59 로 scorecard 에 진짜 작업 옆에 섰다), 사용량 한도 abort 한 건은 abort 안내문을
읽고 "세션 한도로 실패" 0%, `hello` 는 "planning 실패" 0% — 셋 다 Work 판 attention
정렬 맨 위에 떴다. 규칙은 `bridge/src/apme/task-gradeability.ts` **한 곳**(runner 와
reaper 의 enqueue 게이트가 같이 읽는다): `no_reply`(에이전트 응답 없음) ·
`aborted_only`(모든 턴이 클라이언트 종료 — 한도/인증/API, "응답"은 안내문) ·
`trivial`(툴 없는 단일 교환, 프롬프트 ≤12자·응답 ≤200자 — 인사말). 거부된 task 는
`notes_json={"notGradeable":…}` 로 이유가 찍히고 Work 판이 `not graded · no reply
captured` 처럼 그대로 말한다 — 조용히 건너뛰면 "unjudged" 가 백로그로 읽힌다.

**응답 소스는 에이전트별로 정한다** (`bridge/src/hook-response-source.ts`, 순수함수).
인라인 텍스트(`last_assistant_message` …)가 있으면 그것, 없으면 Claude transcript 는
Claude 리더, Codex rollout 은 Codex 리더. 이전 규칙은 "`transcript_path` 가 있으면 Claude
리더" 였는데 Codex 훅도 `transcript_path` 를 싣는다 — 자기 rollout 경로다 — 그래서 한 주의
codex stop 턴 128건 중 **3건**만 응답을 가졌고 나머지 task 는 침묵을 채점받았다. 같은
페이로드에 `model` 도 실려 있어 codex run/turn 의 model_id 는 전부 NULL 이었다; 이제
Codex 는 훅의 `model`, Claude 는 transcript(단 `<synthetic>` — 클라이언트 abort 안내문의
모델명 — 은 제외)에서 읽고, `collector.updateModel` 이 run 뿐 아니라 **turn** 에 찍는다
(`turns.model_id` 가 scorecard 의 원천인데 훅 관측 턴 648건이 전부 NULL 이었다). 과거
codex 턴 732건은 rollout 전체 스캔으로 응답을 1회 복원했다(`efficiency_json.
response_source=rollout_backfill_2026-09-03`).

**Stop 시 빈 transcript 읽기는 답이 아니다.** Claude Code 는 마지막 assistant 레코드를 쓰는
도중에 Stop 훅을 돌린다 — 실측: Stop 21:20:22Z, 1,638자 응답 레코드 21:20:22.395Z. 한 주
Claude stop 턴 344건 중 113건이 그렇게 응답 없이 보관됐다. `deferred-reply-read.ts` 가
1.5s·6s 두 번 다시 읽어 `setLastClosedTurnResponse`(기존 응답은 덮지 않음)로 넘긴다.
과거 30일의 Claude 턴 396건은 transcript 전체 스캔(턴 창 안의 마지막 assistant text)으로
1회 복원했다(`response_source=transcript_backfill_2026-09-03`).

**근거 없이 내려진 판정은 시작 시 철회된다** (`retractUngradeableVerdicts`, 30일 창,
멱등): 규칙이 지금 거부할 task 의 judge/scorer 행을 지우고 요약·점수·outcome 을 비운 뒤
`notGradeable` 을 찍는다(수동 `abandoned` 는 사용자의 진술이라 보존). 반대로 규칙이
느슨해져 다시 판정 가능해진 task 는 stamp 를 지워 백로그로 돌려보낸다 — 첫 규칙은
"응답 없음=거부" 였고 헤드리스/워크플로 에이전트(마지막이 Write 나 Bash, 맺음말 없음)
67건의 타당한 판정을 철회했다가, 툴 궤적(호출 ≥3 또는 파일 기록)을 작업 증거로 인정한 뒤
64건이 재입장했다.

**judge 백로그는 데몬 틱이 배출한다.** task 의 judge 호출은 collector 의 close 경로에서
한 번 발화하므로 재시작 중·judge 오프라인·probe 미완이면 영영 잃었다 — closed 미채점
1,060건. `listTasksNeedingSummary` 는 호출자가 없었다. 이제 틱 1b 가 judge probe 가
`ready` 일 때만 3건씩, 30일 창 안에서, 거부된 task 를 제외하고 enqueue 하며, runner 는
프로세스당 task 별 실패 2회 후 다시 올리지 않는다.

#### end_source — Stop hook 유실률 상시 계측

Claude 턴을 닫는 권한은 Stop hook **하나뿐**이고 그 전달은 fire-and-forget 이라 보장되지 않는다. 문제는 유실이 구조적으로 안 보인다는 점이다 — Stop 이 유실된 턴은 "다음 프롬프트에 닫힌 턴"과 행 모양이 똑같다. `end_source` 는 **어느 신호가 그 턴을 닫았는지**를 기록해 유실을 일화가 아닌 비율로 만든다:

| 값 | 의미 |
|----|------|
| `stop` | 진짜 Stop hook 도착 — 정상 |
| `synthetic_stop` | Stop 유실 → `claude-turn-watchdog.ts` 가 transcript tail 근거로 복구. **이 개수가 곧 유실 측정치** |
| `next_prompt` | Stop 도 없고 복구도 없었음 — 다음 프롬프트가 밀어내며 닫음. **미복구 유실** |
| `interrupted` | 사용자가 ESC 로 취소 — Claude Code 는 취소 시 hook 을 **하나도 emit 하지 않으므로** 애초에 올 Stop 이 없었다. 유실이 아니다 |
| `aborted` | **클라이언트가** 턴을 끝냄 — 사용량 한도(`You've hit your session limit`), 인증 만료(`Please run /login`), 크레딧 소진, API 429/529. assistant 레코드 하나에 `stop_reason: "stop_sequence"` 로 기록되고 Stop hook 은 발화하지 않는다. 취소와 같은 이유로 유실이 아니다 |
| `superseded` | 이 프롬프트의 턴이 **돌기도 전에** 다음 프롬프트가 도착 — 큐잉된 메시지와 `<task-notification>` 주입은 ~130ms 간격 쌍으로 들어오고, 모델 턴 하나가 둘을 처리하며 Stop 도 하나만 빚진다(마지막 것에 대해). 밀려난 행은 "프롬프트당 턴 1개" 계수 방식의 산물이지 유실이 아니다 |
| `session_end` / `clear` | 턴이 열린 채로 세션이 끝나거나 `/clear` 로 잘림 |
| `run_close` | 열린 턴 밑에서 abandoned-run reaper 가 run 을 닫음. 실측(2026-09-03, 5.5일): 52건 중 45건이 턴 시작과 다음 턴 사이에 **데몬 재시작**을 끼고 있었다 — 에이전트가 Stop 을 잃은 게 아니라 받을 프로세스가 없었다. `stop-health` 의 `Reaped` 열로 따로 세고, 비율에는 넣지 않는다(세션 종료로 접어 세던 시절 codex 유실 29% 가 11% 로 읽혔다) |
| `NULL` | 아직 열려 있음(`ended_at IS NULL`), 또는 컬럼 도입 이전 행 |

컬럼 도입 이전 행은 **backfill 하지 않는다**. 당시엔 전부 다음 프롬프트에 닫혔으므로 Stop 도착 여부를 구분할 근거가 없고, 추측 backfill 은 이 컬럼이 재려는 바로 그 비율을 오염시킨다. `stop-health` 는 그 행들을 `?` 로 따로 센다.

**ESC 취소를 유실로 세지 않는 이유와 그 근거 위치.** 취소는 `PostToolUse`/`Stop`/`UserPromptSubmit` 중 무엇도 emit 하지 않으므로(2026-07-18 실측) 전달될 Stop 자체가 없다 — 이걸 `next_prompt` 로 두면 사용자의 ESC 키가 인프라 유실로 집계된다. 증거는 transcript 의 interrupt 마커 하나뿐이고, 판별 규칙은 `bridge/src/claude-interrupt-marker.ts` 한 곳에 있다(관측자·워치독·collector 3소비자 공용). 마커는 **text 블록만** 본다 — `tool_result` 가 같은 문장을 인용하는 일이 흔해서(자기 transcript 를 grep 하는 세션이면 반드시 생긴다) 원문 매칭은 유령 취소를 만든다.

취소는 두 지점에서 잡힌다. 마커가 tail 로 남아 있으면 워치독이(= ESC 후 그대로 둔 경우, 5분 stuck timeout 까지 PROCESSING 으로 남던 것도 같이 해소), 취소 직후 바로 다시 입력해 마커가 새 프롬프트 밑에 묻히면 다음 프롬프트의 close 경로가 `readOpenTurnEvidence` 로 확인한다. 후자의 읽기는 **이미 열린 채 밀려난 턴**에서만 발생한다 — 정상 턴은 Stop 이 그 전에 닫는다.

**클라이언트 중단(`aborted`) 을 유실로 세지 않는 이유.** `stop_reason: "stop_sequence"` 는 모델이 아니라 클라이언트가 턴을 끝냈다는 뜻이고, 그 레코드 뒤에 Stop hook 은 오지 않는다. 추측이 아니라 실측이다 — 로컬 transcript 211개(assistant 레코드 61,281건)에서 `stop_reason` 은 `tool_use` 58,765 / `end_turn` 2,513 / `stop_sequence` 37 이었고, 그 37건은 **전부** 한도·인증·크레딧·API 오류 메시지였으며, **하나도** `stop_hook_summary` 레코드가 뒤따르지 않았고, 같은 턴에서 assistant 작업이 이어진 것도 없었다. 혼동할 양성 모양이 존재하지 않는다.

이 값이 중요한 진짜 이유는 통계가 아니라 **턴이 안 닫히는 것**이다. 중단된 턴은 워치독의 `end_turn` 술어에 걸리지 않아 다음 프롬프트까지 열려 있었고 — 2026-08-16 실측 두 건 모두 **8시간 넘게** — 그동안 모든 기기에 PROCESSING 으로 떠 있고 APME run 도 열린 채였다(open run/task 는 eval 을 굶긴다). 이제 워치독이 ~15초 안에 닫는다.

**`superseded` 는 계수 방식의 산물이다.** 턴은 `UserPromptSubmit` 마다 생성되는데, 큐잉된 메시지와 `<task-notification>` 주입은 ~130ms 간격 쌍으로 도착하고 Claude 는 그 둘을 **모델 턴 하나로** 처리한다. 그래서 앞 행은 "돌지도 않은 턴"이고 Stop 은 마지막 행 하나에만 빚진다. 판별 근거는 시간 임계값이 아니라 transcript 다 — 턴이 열린 뒤 assistant 레코드가 **하나도** 없으면 그 턴은 돈 적이 없다. transcript 를 못 읽으면 `next_prompt` 로 남긴다(읽을 수 없음 ≠ 근거 없음).

```bash
agentdeck apme stop-health --since 7d [--agent claude-code]
```

분모는 **판정 가능한 턴만** — `stop + synthetic_stop + next_prompt`. 열린 턴·취소된 턴·중단된 턴·밀려난 턴·세션 종료로 닫힌 턴·reaper 가 닫은 턴(`Reaped`)·도입 이전 행은 Stop 도착 여부의 증거가 아니므로 비율에서 제외한다. 어느 버킷이 분자·분모에 들어가는지는 `stopDeliveryLoss()`(`@agentdeck/shared`) 한 곳에만 있다 — 소비자가 그 규칙을 다시 적으면 범례가 주장하는 것과 다른 값을 재게 된다. 다만 `total` 에는 열린 턴이 포함되는데, 열린 턴이야말로 "아직 안 온 Stop" 이라 분모에서 빼면 측정하려는 실패를 숨기게 되기 때문이다.

### steps — 훅 이벤트 + tool 호출 기록

```
id, run_id, ts, kind (UserPromptSubmit|PreToolUse|PostToolUse|Stop|...),
tool_name, payload (JSON)
```

### evals — 평가 결과 (결정론 + judge + turn-level + vibe)

```
id, run_id, turn_id (nullable), layer, metric, score, raw (JSON),
rubric_ver, judge_model, created_at
```

- `layer`: `deterministic` | `llm_judge` | `turn_judge` | `vibe`
- `turn_id`: `layer='turn_judge'`인 경우만 사용 — 특정 턴에 연결된 eval
- `metric`: `build_ok`, `tests_pass`, `lint_clean` (결정론) / `overall`, `task_completion`, `code_quality`, `efficiency`, `accuracy`, `helpfulness`, `diagnosis`, ... (카테고리별 axes)
- `raw`: judge의 JSON 응답 전체 (`reasoning`, `done`, `missed` 포함)

### rubrics — 루브릭 버전 관리

```
version (PK, auto-assign), purpose, prompt, weights (JSON),
created_at, parent_ver (lineage), notes
```

Store 초기화 시:
- `version=1` 로 `purpose='general'` (코딩 루브릭) seed
- 그 후 `CATEGORY_RUBRICS`의 6종(conversation/planning/research/debugging/refactoring/review)을 **version 자동 할당**으로 seed
- `getCurrentRubric(purpose)`는 해당 purpose의 최신 version 반환
- `appendRubric()` 가 새 버전을 추가한다 (parent_ver 링크). 이 API 를 부를 튜너는 아직 없다 — 아래 **Rubric auto-tuning** 절 참고

### vibe_feedback — 사용자 승인/거절

```
id, run_id, verdict (approve|reject|neutral), note, ts
```

### 집계 뷰

```sql
v_run_metrics           -- run별 overall + tests_pass 단일값 (MAX로 축약)
v_model_scorecard       -- (agent_type, model_id) 그룹: runs, avg_overall,
                        --  avg_tests_pass, total_cost, cost_per_quality
v_category_scorecard    -- (task_category, model_id) 그룹: runs, avg_overall,
                        --  avg_tests_pass, total_cost
```

`v_category_scorecard`가 "카테고리별 어느 모델이 좋은가"를 직접 보여주는 뷰.

## Wiring into the bridge

### Session bridge (`bridge/src/index.ts`)

1. `startSession()` 진입 시 `await initApme()` → `core.setApme(apme, cwd)`
2. **Claude Code**: `adapter.on('event', 'hook')` → `claudeHookToSpans` → `apme.collector.ingestSpan(sessionId, span)`
3. **Non-Claude 에이전트** (OpenClaw/OpenCode/Codex): `wireAgentApme(adapter, agentType, apme, core)` — timeline 이벤트(OpenClaw/OpenCode)와 Codex lifecycle hook + notify를 collector로 변환
4. **Claude Code 응답 캡처**: Stop hook의 `transcript_path` JSONL tail 을 읽어 `setTurnResponse()` (`readClaudeTranscriptLastTurn`). Stop 자체가 유실되면 hook 침묵 + transcript `end_turn` 레코드를 근거로 synthetic Stop 을 주입해 **같은 경로로** 닫는다 — 화면(PTY) 파싱은 어느 단계에도 없다. 복구는 세션 종류별로 두 벌:
   - **legacy managed PTY** (`agentdeck claude`) — `claude-turn-watchdog.ts`, 브리지 프로세스당 1개, 어댑터 이벤트 파이프로 직접 주입
   - **hook-observed** (터미널에서 직접 `claude`) — `observed-turn-watchdogs.ts`, 데몬 1프로세스가 session_id 로 다중화하므로 **세션당 1개**. 복구는 데몬이 자기 loopback `/hooks/Stop` 으로 self-POST 한다: Stop 분기는 상태머신·타임라인·APME·모델복구·스티어링 6가지를 하는데 그 두 번째 사본은 반드시 드리프트하므로, 복구 경로는 원래 경로와 **같은 경로여야** 한다. 1.0.20 은 앞의 한 벌만 있었고 실측상 기록된 Claude 턴은 전부 후자여서 복구가 한 턴도 걸리지 않았다

   synthetic Stop 에서 지켜야 할 계약 두 가지: **디렉티브 큐를 소비하면 안 된다**(`takeDirectiveForStop`) — 전달은 Claude 가 기다리는 hook 을 block 해서 이뤄지는데 self-POST 응답은 아무도 안 듣기 때문에, 큐에서 꺼내면 사용자 후속 지시가 조용히 증발한다. 그리고 **세션이 식으면 워치독을 수거해야 한다** — 관측 세션은 죽을 때 SessionEnd 를 안 보내므로(터미널 닫힘, 슬립) 수거 없이는 5초 폴링이 데몬 수명 내내 남는다

> **관측(observed) 세션의 응답 캡처는 데몬 쪽에 따로 있다.** 위 세션 브리지 경로는 `agentdeck claude` 로 띄운 managed 세션 전용이라, 직접 실행한 `claude`/`codex`/`opencode` 는 이 경로를 타지 않는다. 그 결과 hook 으로만 관측되는 세션은 프롬프트와 툴 궤적만 아카이빙되고 **응답은 통째로 유실**됐다 (claude-code turn 1589개 중 response 219개, 마지막이 2026-07-11; `assistant_message` 궤적 이벤트는 전 기간 15개뿐이고 그중 12개가 OpenClaw). 대시보드가 TIMELINE 이 온전히 보여주는 대화를 재현할 수 없었고, judge 는 침묵을 채점하고 있었다. 지금은 `daemon-server.ts` 의 stop 훅 핸들러가 타임라인 행을 결정하는 **같은 분기에서** `setTurnResponse()` 를 호출한다. Swift 데몬도 같은 증상이었지만 원인이 달랐다 — `getLastEntry(type:"chat_end")` 를 읽었는데 `chat_end` 는 응답이 **없을 때만** 나오는 행이라 구조적으로 응답을 볼 수 없었다(`DaemonServer.appendClaudeCodeChatEnd` 로 이동).
5. `usage_info` 메타데이터 → `apme.collector.updateUsage(sessionId, snapshot)`
6. `state_changed` → `apme.collector.updateModel(sessionId, modelName)`

> **실패한 턴도 턴이다 — 이유를 남기고, 경계는 그대로 둔다.** OpenClaw `chat` 의 `error` 프레임은 오래도록 궤적에 아무것도 남기지 않았다. 그래서 실패한 턴이 `turn_start` 만 있고 응답도 주석도 없는 모양으로 도착했고, 이는 **응답 이벤트가 유실된 턴과 바이트 단위로 동일**해서 judge 도 사람도 프로바이더 장애와 우리 캡처 버그를 구분할 수 없었다. 지금은 `agent_error` span(`agentdeck.error_label` / `.error_detail`)이 `info` 궤적 이벤트로 기록된다. 두 가지가 계약이다 — **(1) 태스크를 닫지 않는다**: 에이전트가 같은 프롬프트를 재시도할 수 있으므로 경계는 여전히 idle-gap 타이머 소유다. **(2) 그 타이머를 다시 건다**: `chat.send` 가 타이머를 지우고 `final` 만 다시 걸었기 때문에, 에러 후 사용자가 자리를 뜬 프롬프트는 태스크가 영영 열린 채 남아 eval 을 굶겼다. 라벨 문자열은 어댑터의 타임라인 행 `raw` 와 **같은 헬퍼**(`openclawChatErrorLabel`)에서 나온다 — `AGENTDECK_TIMELINE_PROJECTION=1` 일 때 projection 이 같은 실패를 `error` 행으로 되돌리는데, `error` 는 `PROJECTED_TYPES` 에 없어 어댑터 행이 억제되지 않으므로 두 문자열이 바이트 동일해야 스토어의 exact-dedup(같은 type+raw, 8초)이 둘을 합친다.
>
> Gateway 의 error 프레임은 `errorMessage`/`errorKind`/`stopReason`/`runId` 만 싣는다 — **프로바이더도 모델도 없다**(failover 때문에 실패한 모델은 턴이 끝난 모델과 애초에 다르다). 그래서 행의 `detail` 은 프레임이 준 것 + 어댑터가 아는 턴 사실(소요 시간, 사용 툴)로만 구성하고 없는 건 추측하지 않는다. `runId` 는 프로바이더·모델·HTTP 상태가 실제로 남는 OpenClaw gateway 로그로 들어가는 join key 라서 넣는다.

### BridgeCore (`bridge/src/bridge-core.ts`)

- `registerSession(agentType)` → `apme.collector.openRun()` (daemon meta-session 제외)
- `deregisterSession()` → `apme.collector.closeRun()` + `apme.runner.enqueue()`

### Daemon (`bridge/src/daemon-server.ts`)

- 부팅 시 `await initApme()` (HTTP routes + 30s loop용)
- `/apme/*` 요청 → `handleApmeRequest(req, res, apme)` 로 dispatch
- **30초 주기 루프**:
  1. 미평가 run 큐에 enqueue
  2. 10초 이상 닫힌 run의 outcome 계산
  3. `task_category IS NULL` 재분류 (세션 프로세스 조기 종료 복구)
  4. orphan run 태깅 — `task_prompt` 도 turn 도 없는 **빈 껍데기**만 대상
  5. **abandoned run 수확** — 4번이 볼 수 없는 것들. 이들은 실제 프롬프트·턴·툴 궤적을 갖고 있어 4번의 빈-껍데기 술어를 통과하지 못하고, **task 도 닫히지 않으므로 평가가 아예 돌지 않는다** (실측: open task 65 vs closed 9). 마지막 활동 시각 기준 2시간 무활동(`AGENTDECK_APME_ABANDON_SEC`)이면 turn/task/run 을 **그 마지막 활동 시각으로** 닫고, 응답 텍스트가 있는 task 만 judge 에 enqueue 한다. `collector.isLiveRun()` 으로 자기 프로세스가 아직 쥐고 있는 run 은 건너뛴다. **task 의 boundary 는 reaper 가 무엇을 발견했는지를 말한다** (2026-09-03): 모든 턴이 닫혀 있던 task 는 깨끗이 끝난 뒤 조용해진 것이므로 `idle_gap`(타이머가 프로세스와 함께 죽어 늦게 도달했을 뿐 같은 경계), **열린 턴을 쥔 task 만 `orphaned`** 이고 그 턴은 `run_close` 로 닫힌다. 전부 `orphaned` 로 찍던 시절 한 주의 task 79% 가 "reaper" 칩에 들어갔고, 그중 대부분은 세그먼테이션이 옳았던 경우였다. 양 데몬 미러(`ApmeStore.reapAbandonedRun`), 분류는 턴 UPDATE **이전**에 — 턴을 닫는 순간 구분이 사라진다.

  **재시작은 더 이상 이 경로를 먹이지 않는다.** 데몬이 시작하면 첫 훅을 받기 전에 `collector.rehydrateOpenRuns()` 가 store 의 open run 을 전부 다시 채택한다 — session→run 엣지, open task(턴 범위·첫 프롬프트), open turn(툴 카운터는 `sample_events` 에서 복원 — 카운터는 turn close 때만 flush 되므로 재시작을 넘긴 턴은 예외 없이 `tool_calls=0` 으로 닫히고 있었다), 그리고 마지막 턴이 닫힌 세션엔 **남은 만큼**의 idle-gap 타이머(다운타임 중 이미 지났으면 0 → 다음 틱에 `idle_gap`). codex 의 열린 턴은 rollout 에 한 번 물어본다: 턴보다 새로운 `task_complete` 는 이 데몬이 못 받은 Stop 이므로 `synthetic_stop` 으로 닫고 응답을 싣는다(`codexTurnCompletionSince`). 실측 근거: 머지 후 5.5일간 reaper 가 닫은 task 68건 중 60건이 재시작을 끼고 있었고(개발 머신, 5일간 재시작 40회), 갓 추가된 idle-gap 경계는 그중 어느 것도 닫을 수 없었다 — 타이머가 죽은 프로세스 안에 있었으니까. 데몬 전용이다: 세션 브리지가 데몬의 run 을 채택하면 훔치는 것이 된다. Claude 의 열린 턴은 transcript 경로가 run 에 저장되지 않아 시작 시점엔 검사하지 않고, 세션의 다음 훅에서 재구성되는 관측 워치독에 맡긴다. Swift 데몬은 아직 재수화하지 않는다(reaper 의 정직한 boundary 만 미러).
- `apme.runner.onResult()` 리스너: 평가 완료마다 `apme_eval` WS 브로드캐스트 + `BridgeTimeline.addEntry({ type: 'eval_result' })`

## Task classification

`classifier.ts` — 수집된 run을 10개 카테고리 중 하나로 분류한다.

### Signals (`computeSignals`)

Steps 테이블을 훑어 `TaskSignals` 구조체 생성:

```
toolCounts, dominantTool, totalToolCalls,
turnCount, sessionDurationSec, promptLengthChars,
planModeUsed, permissionRequests, diffReviews,
filesCreated, filesModified, testCommandsRun,
webSearches, agentDelegations, isAutomated,
ocToolNames
```

### Rule-based categories

우선순위 순서:

| 우선순위 | Category | 조건 |
|---|---|---|
| 1 | `multi_agent` | ≥2 delegations |
| 2 | `planning` | plan mode 사용 |
| 3 | `conversation` | ≤2 tools, <120s |
| 4 | `planning` | 1-3 turns, 파일 변경 없음 |
| 5 | `research` | web search + grep/glob |
| 6 | `debugging` | tests + edits + bash |
| 7 | `refactoring` | >50% Edit, 3+ 파일 수정 |
| 8 | `coding` | Edit/Write + 파일 변경 |
| 9 | `review` | >50% Read, ≥5 tools, ≤1 파일 수정 |
| 10 | `ops` | >50% Bash |
| — | `unknown` | 위 어디에도 해당 없음 |

### LLM fallback

`unknown`이면 `classifyWithLlm(prompt, signals)` — 로컬 MLX에 task prompt + tool 요약을 보내 분류 요청. 비용 0.

### `classifyRunSmart(store, runId)`

엔트리 포인트. rules → unknown이면 LLM → `{ signals, category, source }` 반환.

## Evaluation pipeline

### 카테고리별 평가 전략

APME의 핵심 결정: **카테고리마다 평가 방법이 다르다.**

```
┌─────────────────┬──────────────────┬────────────────────────────┐
│   카테고리       │  평가 타이밍      │   사용하는 레이어           │
├─────────────────┼──────────────────┼────────────────────────────┤
│ coding          │                  │                            │
│ refactoring     │  run-level       │ deterministic + llm_judge │
│ debugging       │  (세션 종료 후)   │ (카테고리별 루브릭)         │
├─────────────────┼──────────────────┼────────────────────────────┤
│ conversation    │  turn-level      │                            │
│ planning        │  (턴 직후)       │ llm_judge only             │
│ research        │  task-level      │ (결정론 레이어 없음)        │
│ review          │  (태스크 경계)   │                            │
├─────────────────┼──────────────────┼────────────────────────────┤
│ ops             │                  │                            │
│ multi_agent     │  run-level       │ deterministic + general    │
│ unknown         │                  │ rubric fallback            │
└─────────────────┴──────────────────┴────────────────────────────┘
```

### Layer 1 — Deterministic (코딩 run-level만)

`runDeterministic(run, cfg)` in `runner.ts`:

1. `detectLanguage(projectPath)` — `package.json` → typescript, `.xcodeproj` → swift, `build.gradle*` → kotlin
2. `hasChanges(run)` — git diff 확인. 변경 없으면 skip (stale baseline 방지)
3. 명령 실행 (`spawn('sh', ['-c', cmd])`) — 각 단계별 timeout, exit code 캡처
4. 기본 명령: TS(`pnpm lint/build/test`), Swift(`xcodebuild test`), Kotlin(`./gradlew testDebugUnitTest`)
5. 결과 → `evals` 테이블에 `layer='deterministic'`, `score=0|1`

명령 override: `settings.json.apme.deterministic.commands.typescript.test = "vitest run --reporter=json"`

### Layer 2 — LLM Judge (G-Eval)

`shouldJudge(cfg.judge, layer1Passed)` 게이트 후 실행:

1. `store.getCurrentRubric(run.taskCategory)` — 카테고리별 루브릭 선택, 없으면 `general` fallback
2. `buildJudgePrompt()` — 루브릭 prompt + task_prompt + git diff + deterministic 결과 + 메타데이터
3. `callJudge()` — 백엔드 분기:
   - `mlx` → `http://127.0.0.1:8800/v1/chat/completions` (OpenAI-compatible, **기본값**)
   - `foundationModels` → `http://127.0.0.1:port/apme/judge/foundation-models` (Swift daemon 경유 Apple Intelligence, App Store 빌드 전용)
   - `openclaw` → `http://127.0.0.1:18789/chat` (Gateway 라우팅, 보조)
4. `parseJudgeJson()` — JSON 추출, 0-10 스케일 자동 정규화, 코드펜스 관용
5. 결과 → `evals` 테이블에 `layer='llm_judge'`, 카테고리별 axis metrics (예: debugging → `diagnosis/fix_quality/verification/overall`)

게이팅 기본값: `sampleRate: 1.0` (모든 run 평가), `onlyWhenDisagreement: false`. 로컬 MLX라 비용이 0이므로 전수 평가가 기본. 필요 시 축소 가능.

### 판정 응답 유효성과 서빙 재현

MLX와 OpenAI 호환 응답은 **양 데몬 모두** `choices`가 비어 있지 않은 **배열**이어야 하고,
content 는 비어 있지 않은 문자열이어야 한다. 빈 문자열·공백·content 누락·`choices` 부재는
실패다. `finish_reason=length` 는 본문이 **닫힌 JSON 객체를 하나도 담고 있지 않거나, 마지막으로
닫힌 객체 뒤에 닫히지 않은 `{` 가 남아 있을 때** 거부한다 — 두 번째 조건은 아래의 모호성
규칙이 볼 수 없는 경우다. 추론 모델이 `<think>{"overall":0.5}</think>` 를 닫고 나서 진짜
`{"overall":0.9…` 를 쓰다 잘리면 닫힌 구간이 **하나뿐**이라 모호해 보이지 않고 초안이 점수가
된다
(순수하게 **구조적** 질문이다 — "파싱되는가"가 아니다. 두 데몬의 JSON 파서는 관대함이
다르다: 실측상 Swift `JSONSerialization` 은 Gemma 4 가 뱉는 trailing comma 를 받아들이고
Node `JSON.parse` 는 거부한다. 그렇게 물으면 데몬마다 답이 갈리는데, 균형 스캐너는 양쪽이
동일하므로 이 질문은 갈리지 않는다)
— 객체가 닫혔다면 그것이 완성된 판정이고 닫는 중괄호 뒤에 모델이 더 쓴 것은 판정의 일부가
아니다. 반대로 객체 도중에 잘린 본문은 애초에 파싱되지 않으므로 `parseJudgeJson` 이 같은
케이스를 이미 거부한다. 잘림 검사는 실패 사유를 "잘렸다"고 말할 수 있게 하려고 남아 있다
(#286). 실측: gemma-4-26b 는 일부 프롬프트에서 `summary` 문자열 안에서 같은 문장을 반복하다
800토큰 상한에 닿고 객체를 끝내 닫지 않는다 — 이것이 이 규칙이 거부해야 하는 본문이다.

본문에서 객체를 꺼내는 방식도 양 데몬이 같아야 한다. Node 는 첫 `{`부터 **마지막** `}`까지
집는 greedy 정규식이었고 Swift 는 균형 스캐너였다 — 판정 뒤에 중괄호가 든 산문이 붙으면
한쪽만 거부한다. 잘린 본문을 받아들이기 시작하면 "닫는 중괄호 뒤의 텍스트"가 바로 그
경로이므로 Node 도 균형 스캔을 먼저 쓴다. 다만 키의 여는 따옴표가 빠진 본문은 문자열
추적 자체가 어긋나므로(그래서 `repairJudgeJson` 이 있다) greedy 구간을 두 번째 후보로
남긴다. 응답 게이트는 `shared/apme-judge-response-vectors.json`을, Anthropic `api` 레그는
`shared/apme-judge-api-response-vectors.json`을 Vitest와 macOS XCTest 에서 함께 재생한다
(`api` 레그는 SDK 를 통해서만 도달하므로 자기 벡터 파일이 없으면 규칙을 지워도 양쪽
스위트가 초록이었다). JSON 파싱·루브릭 검증은 그 다음 단계다.

여러 객체 중 **무엇이 판정인지는 위치가 아니라 `overall` 필드로 정한다.** 균형 스캔은
파싱 가능한 구간을 늘리므로 "먼저 파싱되는 것"은 안전한 규칙이 아니다 — 로컬 추론 모델이
답 앞에 스크래치패드 객체를 뱉으면 그걸 점수로 저장한다. `overall` 을 가진 구간이 둘 이상이면
**모호**로 보고 null(=시끄러운 실패)로 떨어뜨린다. eval 에 들어간 틀린 점수는 건너뛴 것보다
확실히 나쁘다. 벡터 파일의 `accepted` 는 전송 게이트, `verdict`(생략 시 `accepted` 와 동일)는
그 뒤 파서가 판정을 내야 하는지를 뜻한다 — 게이트는 통과시키고 파서는 거부해야 하는 본문은
이 두 축이 없으면 고정할 수 없다.

판정 요청은 **`response_format: {"type":"json_object"}`를 보낸다**. 프롬프트가 JSON을
요구하고 러너가 JSON으로 파싱하는데 서버에는 아무것도 요구하지 않던 상태였고, 모델이
객체를 산문으로 감싸면 판정 불가 → 재시도 → 30분 park 가 반복된다(실측: 한 task 가
3시간에 6회, 9/3 이후 17회 park 되고 끝내 판정되지 않았다). 이 필드는 보편적이지 않아
일부 OpenAI 호환 서버는 400/422로 거부하는데, 그런 서버가 판정 자체를 잃으면 안 되므로
**거부 시 필드 없이 1회 재시도**하고 그 엔드포인트를 기억한다 — 탐색 비용은 프로세스당
엔드포인트 1회이지 판정 1회당이 아니다. 401·429·5xx는 필드 거부가 아니므로 그대로
올린다(재시도하면 인증 실패가 같은 실패 뒤에 숨는다). MLX의 context overflow 400은
기존대로 프롬프트를 압축해 재시도하며 JSON 모드를 유지한다.

`apme.judge.reasoningEffort`는 **Node의 OpenAI 호환 백엔드 전용 선택 옵션**이다.
`none | low | medium | high | max`를 `reasoning_effort`로 전달하며 생략하면 서버 기본값을
유지한다. 지원 여부는 서버·모델에 달려 있다. Swift에는 이 옵션을 아직 적용하지 않았으며,
공통 응답 유효성 규칙과 백엔드별 조절 옵션을 구분한다.

개발용 재생 도구는 데몬을 시작하지 않고, 사용자가 준비한 일관된 SQLite 스냅샷의
**사본에만** 판정을 저장한다. WAL 사용 중인 DB 파일만 복사하지 말고 SQLite backup으로
`fixture.sqlite`를 준비한다. `selection.json` 형식은
`[{"case":"AD01","taskId":"<snapshot task id>"}]`이며, 원문·DB·응답은 저장소 밖에 둔다.
`boundaries.json`은 `[{"case":"INPUT12K","prompt":"<synthetic prompt>"}]` 형식이다.

```bash
pnpm build
BENCH_PROFILE=mlx-baseline-01 BENCH_SERVER_REVISION='<server commit + model digest + context/cache settings>' \
  node scripts/apme-serving-normalized.mjs /absolute/private/fixtures mlx
# 비정규화 요청/프롬프트 캡처: apme-serving-replay.mjs PRIVATE_DIR capture|mlx|ollama
# 입력 경계: apme-serving-boundary.mjs PRIVATE_DIR mlx|ollama
```

정규화는 출력 800·온도 0·top_p 1·seed 42·추론 끔을 요청하고, 최초/즉시 반복/전체 재방문을
기록한다. 서버가 요청 옵션을 실제로 적용했는지는 서버 계측으로 별도 확인해야 한다.
`manifest.json`에는 소스 커밋과 작업 트리 상태, 실제 bridge/shared 빌드 해시, 스크립트·입력
해시, Node 버전, 서버 식별 설명이 들어간다. 조건이 달라지면 새 프로필을 요구하고 기존
성공·실패·중단 결과를 덮어쓰지 않는다. 결과 없는 `.started.json`은 중단 시도다. 모델 이름은 과거 실험의 명시적 고정값이다.
다른 모델로 실험하면 스크립트 변경과 서버 모델 digest를 함께 기록해야 한다.

2026-09-06 기록상 기본 MLX와 추론을 끈 Ollama는 각각 30/30 저장에 성공했다.
APC 기본과 APC 24개+JSON object는 각각 27/30이었고, 초기 중단 19회도 보존했다.
이는 **서빙 완료율**이다. 판정 정확도·동등성의 근거로 사용하지 않는다. 운영 MLX 선택과
실패 사례의 상세 근거는 DEVELOPMENT_LOG의 같은 날짜 두 실험 항목에 유지한다.

다음 품질 비교는 고정 입력·루브릭 버전과 사람이 확인한 기준 판정을 먼저 준비한다.
완료율/형식 유효성, 사람과의 축별 일치·오판, 반복 편차, 지연·토큰·비용을 각각 보고한다.
과거 자동 점수는 정답으로 취급하지 않고, 누락·변경된 응답이 있는 작업은 기준셋에서
구분한다. 이 기준셋과 품질 비교는 아직 완료되지 않았다.

관측 검증도 평가의 선행 조건이다. SubagentStart와 PERM의 라이브 근거는
DEVELOPMENT_LOG의 `2026-09-06 — PERM 후속 라이브 감사`에 있다. 내부 Claude fork의 Stop을
Agent 실행으로 세지 않으며, 사용량 복구용 CLI 호출은 도구·훅·세션 저장을 비활성화해
사용자 작업의 관측과 평가에 섞이지 않게 한다.

### Turn-level judge (`runner.enqueueTurn`)

비코딩 카테고리 (conversation/planning/research/review)는 턴 완료 직후 즉시 평가:

1. `enqueueTurn({ runId, turnId, category })` 호출 — wireAgentApme에서 `chat_response`마다 트리거
2. 카테고리별 루브릭 선택 (없으면 `conversation` fallback)
3. Judge 입력: turn prompt + response만 (전체 diff 없음)
4. `evals` 테이블에 `layer='turn_judge'`, `turn_id` 연결
5. `onResult()` 콜백 → `apme_eval` WS 브로드캐스트 → 대시보드 Turn 카드에 즉시 표시

### Task-level judge (`runner.enqueueTask`)

`TodoWrite all-completed`, `/clear`, 세션 종료 등의 boundary signal이 감지되면 Task 단위로 묶어서 평가:

1. `enqueueTask({ runId, taskId, category, boundarySignal })` 호출
2. 턴들을 모아 `task_rollup` 루브릭 (없으면 카테고리/general) 적용
3. 턴 텍스트들을 묶어 Judge 에 전송
4. `evals` 테이블에 `layer='task_judge'` 기록 및 `tasks` 테이블에 `compositeScore`, `summary` 업데이트
5. `onResult()` 콜백 트리거

### Outcome & composite score

`outcome.ts`:

**Non-coding** (conversation/planning/research/review): 응답 캡처 여부로 판정 — turns.response가 있으면 `committed` (score 1.0), 없으면 `abandoned`.

**Coding**: git 상태 + 커밋 이력 기반:

| Outcome | Score | 조건 |
|---|---|---|
| `committed` | 1.0 | gitAfter != gitBefore + 커밋 존재 |
| `ab_winner` | 1.0 | A/B 테스트 승리 |
| `iterated` | 0.6 | 여러 번 시도 후 종료 |
| `exploratory` | 0.5 | 변경 있으나 커밋 안 함 |
| `pending` | 0.5 | 진행 중 |
| `interrupted` | 0.3 | 사용자 중단 |
| `abandoned` | 0.2 | 변경 없음 |
| `ab_loser` | 0.1 | A/B 테스트 패배 |

**Composite score** (`outcome.ts`):

```
composite = 0.40 × outcomeScore
          + 0.40 × judgeScore (overall)
          + 0.15 × efficiencyScore
          + 0.05 × vibeScore
```

`efficiencyScore`는 `tokensPerChange`, `costPerChange`, `timeToCompleteSec`, `toolEfficiency`로 산출.

## Rubric auto-tuning — 설계만 있고 **미구현** (2026-08-06 확인)

> **경고**: 이 절은 오랫동안 구현된 기능처럼 서술돼 있었으나, `bridge/src/apme/tuner.ts` 도 `ApmeTuner` 도 `shouldRetune()` 도 `POST /apme/tune` 도 저장소에 존재하지 않는다. 설계 스케치로만 읽을 것.
>
> **실제로 있는 것**: `rubrics` 테이블의 버전 관리(`parentVer` 링크 포함)와 카테고리별 루브릭 seed, `vibe_feedback` 수집(`POST /apme/vibe`), 현재 루브릭 조회(`GET /apme/rubric/current`). 즉 튜너가 읽고 쓸 **저장 구조는 준비돼 있고, 튜너 루프만 없다.**
>
> **없는 것**: disagreement 감지, meta-prompt 제안, shadow-eval, 자동 accept/reject, 자동 실행 트리거, 그리고 그것을 켜고 끄는 `apme.autoTune` 설정(어떤 로더도 읽지 않는다).

구현한다면 이런 모양이었다 — OPRO(Optimization by PROmpting) 스타일:

1. **Disagreement detector**: 최근 30개 run에서
   - `tests_pass=1 ∧ judge.overall<0.5` (false negative)
   - `tests_pass=0 ∧ judge.overall>0.8` (false positive)
   - `vibe=reject ∧ judge.overall>0.8` (judge 과대평가)
   - `vibe=approve ∧ judge.overall<0.4` (judge 과소평가)
2. **Baseline correlation**: `evals.overall` ↔ `vibe_feedback.verdict` 간 Pearson 상관 계산
3. **Meta-prompt**: 현재 루브릭 + disagreement 샘플을 judge 백엔드에 보내 새 `prompt` + `weights` 제안
4. **Shadow-eval**: 제안된 루브릭으로 같은 샘플을 재채점, vibe와의 상관이 개선되었는지 비교
5. **Accept/reject**: 상관 개선 > 0.05 시 `rubrics` 테이블에 새 버전 append (`parentVer` 링크). 미개선 시 폐기 + 로그

자동 실행 조건도 같은 설계의 일부였다: vibe correlation < 0.4 이면 재튜닝, 단 disagreement 샘플 최소 3개. 위 경고대로 이 트리거 역시 코드에 없다.

## Daemon HTTP API

| Method | Path | Description |
|---|---|---|
| GET | `/apme` | 대시보드 HTML (inline SPA) |
| GET | `/apme/activity` | Swift/CLI 로컬 기록을 자동 중복 제거·병합한 간단한 에이전트 활동 요약 |
| GET | `/apme/runs?limit=&agent=&model=` | 최근 runs + evals + overallScore |
| GET | `/apme/run/:id` | 단일 run 상세 (steps, turns, per-turn evals, vibe) |
| GET | `/apme/tasks?limit=&offset=&agent=&session=&project=&category=&outcome=&state=&view=&sort=&q=` | **처리된 task 단위 전체 목록** (paged + faceted) — Work 판의 데이터 소스. `session`은 native `session_id` exact match이며, Work 행의 프로젝트·세션 칩 또는 Run/Task 상세의 **View session work** 버튼이 이 필터를 열어 한 세션의 모든 task를 한 번에 모은다(세션 538개 실측에서 거대한 전역 드롭다운 대신 문맥 안에서 진입). `view` = 라이프사이클 버킷(`attention`/`inprogress`/`judged`/`reported`/`orphaned`), `sort=attention` 은 Work 판 **전용** attention-first 정렬(기본은 순수 최신순 — graph/activity 등 다른 `listTaskPage` 소비자의 기존 계약). 응답에 `viewCounts`(탭 배지 — 행과 **같은 협소 필터**·같은 SQL 정의를 읽되 10초 TTL 캐시라 버킷 이동 직후 최대 10초 지연 가능)와 행별 `title`(`deriveTaskTitle`, `ownFirstPrompt` 전용)·`actionFold`(`foldActionCounts`)·`coordination`(dispatch/메시징 카운트)·`attention` 플래그 포함. 버킷 정의는 store 의 `TASK_VIEW_SQL`/`taskAttentionSql` 한 곳이고 attention 식은 `IFNULL(...,0)` — NULL 점수 행이 DESC 정렬에서 맨 뒤로 가라앉는 SQLite 함정 방지. attention 은 7일 최근성 창(`TASK_ATTENTION_WINDOW_MS`): 실측(2026-08-28)에서 무창 버킷이 1,519개 중 1,412개를 담아 트리아지가 아니라 아카이브였다. **양 데몬 서빙** (2026-08-29): Swift 데몬도 같은 목록 라우트를 서빙한다(`ApmeHttpRoutes` + `ApmeStore.listTaskPage`/`taskViewCounts` — 버킷 SQL 은 Node `TASK_VIEW_SQL`/`taskAttentionSql` 과 표현식 단위로 맞춘 미러, `ApmeTaskBoundaryTests.testListTaskPageBucketsAndViewCounts` 가 배지=행 일치를 고정). 행 강화(`title`/`actionFold`/`coordination`)는 생성 미러 `TaskTitleRules`/`ActionFoldRules`(`pnpm generate-apme-display-rules`, 공유 벡터 파일 리플레이)로 계산한다. 번들 대시보드(`apple/AgentDeck/Resources/apme-dashboard.html`)는 손복사 스냅샷이 아니라 `apmeDashboardHtml()` 의 생성 미러다 — `pnpm generate-apme-dashboard`, drift 는 `apme-dashboard-html.test.ts` 가 바이트 단위로 게이트(손복사 시절 31KB 스냅샷은 Work 판이 통째로 빠진 채 App Store 로 나가고 있었다). 구식 데몬이 목록 라우트를 모르는 경우만 대시보드가 라벨된 상태("Task list unavailable")로 강등된다 |
| GET | `/apme/tasks/:id` | 단일 task 상세 — task row + run context + turns + evals + SessionSample |
| GET | `/apme/graph?limit=&minHubDegree=&turns=&files=&agent=&project=&category=` | 행 저장소의 property-graph 투영 (nodes/edges/stats) |
| GET | `/apme/scorecard` | `v_model_scorecard` |
| GET | `/apme/categories` | `v_category_scorecard` |
| GET | `/apme/samples` | sample-granularity 스코어카드 (Pareto 입력) |
| GET | `/apme/pareto` | (quality, cost) frontier + dominated 분할 |
| GET | `/apme/judge/detect` | 로컬 추론 서버 자동 탐지 (Ollama / LM Studio / MLX) |
| GET | `/apme/rubric/current` | 현재 활성 루브릭 (general) |
| POST | `/apme/vibe` | `{ runId, verdict, note? }` |
| POST | `/apme/recommend` | `{ taskKind?, budgetUsd?, preferLocal? }` → top-3 후보 |

라우트 표는 `bridge/src/apme/http.ts` 의 실제 분기와 1:1이다. 예전에 실려 있던 `POST /apme/tune` 은 구현된 적이 없어 삭제했다(위 auto-tuning 절 참고).

모든 응답은 JSON + `Access-Control-Allow-Origin: *`. APME 미초기화 시 503.

### Unified activity projection

`/apme/activity`의 안정 계약은 `agentdeck-activity/v1`이다. 각 데몬은 자기 APME SQLite만
읽고, 상대 데몬의 DB나 App Store 컨테이너를 직접 열지 않는다. CLI가 Swift 리스너를
인계받기 직전과 Swift가 외부 CLI 데몬을 관찰하는 동안, 인증된 loopback HTTP로 최대
500개의 작은 파생 행만 교환해 각 데이터 디렉터리의 삭제 가능한
`apme-peer-activity.json` 캐시에 보관한다.

동일 행은 agent + native session + task index + 정규화한 첫 프롬프트의 SHA-256 기반
`originKey`를 만든다. 키가 같아도 시간 구간이 겹치거나 5분 이내로 맞닿아야 합치며,
구버전/인계 조각 역시 같은 agent/session/task index와 같은 시간 조건을 모두 만족할 때만
보수적으로 합친다. 애매하면 별도 행으로 둔다. 숫자는 합산하지
않고 더 완전한 쪽의 최대값을 택해 이중 계측을 부풀리지 않는다. 표시하는 사용 시간은
task 벽시계가 아니라 닫힌 turn 실행 구간의 합이며, 현재 실행 중인 turn만 현재까지
누적한다. 따라서 사용자가 응답을 읽거나 다음 프롬프트를 고민한 시간은 제외된다.

## WS protocol additions

`shared/src/protocol.ts`:

**Bridge → Client (BridgeEvent)**:
- `ApmeEvalEvent` — run 평가 완료 시 broadcast (`type: 'apme_eval'`, `run: ApmeRunSummary`)
- `ApmeScorecardEvent` — 모델 스코어카드 갱신 (`type: 'apme_scorecard'`, `scorecards[]`)
- `ApmeRecommendationEvent` — 모델 추천 결과 (`type: 'apme_recommendation'`, `candidates[]`)
- `eval_result` timeline entry — 별도 브로드캐스트 없이 `BridgeTimeline` 스냅샷으로 확산

**Client → Bridge (PluginCommand)**:
- `ApmeVibeFeedbackCommand` — 사용자 vibe check (`type: 'apme_vibe'`, `runId`, `verdict`)
- `ApmeRecommendCommand` — 추천 요청

### Device rendering

`eval_result` timeline entry는 모든 디바이스가 동일한 시각적 언어로 렌더링:

| Device | 렌더링 |
|---|---|
| Stream Deck | ★ amber (score별 색상 override: 녹색 ≥70%, 앰버 ≥40%, 레드 <40%) |
| Apple (SwiftUI) | `ledAmber` LED row, `EVAL` 라벨 |
| Android (Compose) | `LEDAmber`, `EVAL` 태그 |
| ESP32 | `TLToolReq` 섹션에 `@` prefix + 축약 텍스트 |
| TUI dashboard | terrarium timeline strip |

공통 경로: `bridge/src/plugin/renderers/timeline-renderer.ts` (`evalScoreColor`).

### Task hierarchy rows — one-row-per-task render contract (2026-07-19)

`task_start`/`task_end` timeline 행은 **데이터 계층에서는 쌍으로 유지**되지만
(스피너 정지, judge 결과 upsert 매개체, orphan reaper 합성 대상), 렌더링은
태스크당 **헤더(`task_start`) 한 행**뿐이다. 헤더는 매칭 closure(`task_end`,
같은 `taskId`)를 접어 넣는다: judge 요약이 "Task N" 제목을 대체하고, closure
라벨("Session end · 2 turns · 6m 5s")이 칩으로, score/outcome 배지가 함께
렌더된다. eval payload 없는 bare 태스크(리퍼 합성 `interrupted` closure 포함)는
아무 행도 남기지 않는다 — 타임라인은 실제 턴의 activity log로 유지된다.

SSOT: `shared/src/timeline-task-display.ts` (`timelineShouldRenderTaskRow` /
`timelineTaskClosure` / `timelineTaskHeaderDisplay`). 미러: Apple
`TimelineStripView.swift`, Android `TimelineDisplay.kt`+`TimelineStrip.kt`,
TUI `renderer.ts`. 글랜스 표면(ESP32 카드/티커, 양 데몬의
`lastEventText` milestone 선정)은 task 행을 아예 제외하고 turn 행만 쓴다.

### 태스크 이름 — intent 제목 + judge 요약의 우선순위 (2026-08-28)

`task_start.raw` 는 더 이상 `Task N` 이 아니다. 승격 시점에 태스크의 **첫 user
prompt** 에서 제목을 파생한다 — SSOT `shared/src/task-title.ts`
(`deriveTaskTitle`). 규칙: 마크업으로 **시작하는** 프롬프트는 기계 주입이므로
통째로 null(내부 본문을 제목으로 승격하지 않음), 그 외 첫 줄 중 ASCII 슬래시
**명령**(경로 `/Users/...` 는 명령이 아님 — 두 번째 `/` 로 구분)·마크업·코드
펜스가 아닌 줄, 마크다운 장식 제거, **72 code point** 캡(모든 인덱스 연산이
code point — UTF-16 단위 금지), 4 미만이면 null → `Task N` 폴백.

**한 줄 슬롯의 우선순위는 judge 요약 > intent 제목** (`timelineTaskHeaderDisplay`
2026-08-28 계약 플립): 타임라인 행이 갖는 유일한 한 줄에서 outcome 문장이
intent 를 이긴다 — intent 제목은 판정 전(그리고 영원히 미판정인 대다수)의
공백을 채운다. 미러 3곳(Swift `TimelineStripView`, Kotlin `TimelineDisplay`,
TUI=shared 직수입)과 Work 판 라벨이 같은 우선순위를 쓴다.

파생 구현은 Node(`shared/src/task-title.ts`)와 Swift
`ApmeCollector.deriveTaskTitle` 손 미러 두 곳이지만, 패리티는 산문이 아니라
**공유 벡터 파일** `shared/task-title-vectors.json` 이 고정한다 — vitest 와
XCTest 가 같은 파일을 리플레이하므로 한쪽만 고친 규칙 변경은 반대쪽에서
빨간불이 된다. `/apme/tasks` 의 `title` 은 태스크 **자신의** 첫 턴 프롬프트
(`ownFirstPrompt`)에서만 파생한다 — run 프롬프트 폴백을 쓰면 분할된 run 의
태스크 2+가 태스크 0 의 의도로 이름 붙는다.

### 범용 idle-gap 경계 (2026-08-28)

claude-code/codex 는 명시적 경계(`/clear`·manual·session_end)뿐이어서 유일한
암묵 종결이 30분 orphan reaper 였다 — 실측: codex 태스크 **289/289 (100%)**
가 `orphaned`, 평균 2.4시간 열려 있다가 10%만 judge 도달(open-task eval
starvation). collector 가 이제 **turn 종료(closeTurn)에 15분 타이머**를 걸고
새 turn 이 열리면 해제한다(`AGENT_IDLE_GAP_MS`, 측정 근거: 실제 turn 간격의
96%(claude)/87%(codex)가 15분 미만이고 그 위는 대부분 리퍼의 30분도 넘겨 이미
분할되던 구간). 에이전트 무관 범용 — OpenClaw/OpenCode 는 어댑터 소유 90초
타이머(명시적 idle 이벤트 기반)가 먼저 닫고, 이 타이머는 활성 태스크가 없어
no-op. Swift 데몬의 기존 `idleGapSec`(1800→900)도 같은 값으로 정렬(응답 후
arm, min-turn-age 가드 포함 — arm 지점은 다르지만 상수는 한 사실). 게이트:
`bridge/src/__tests__/apme-idle-gap-and-title.test.ts`.

### 재시작 채택은 임시이고, 턴은 에이전트 자신의 기록으로 닫힌다 (2026-09-03)

`rehydrateOpenRuns` 가 열린 run 을 다시 채택한 뒤 남은 구멍 넷을 라이브 창(재시작 2026-09-02
23:40Z 포함 3일)에서 실측해 닫았다.

- **채택은 세션이 말하기 전까지 임시다.** 채택된 run 은 `isLiveRun` 이 영원히 참이라 reaper 가
  건너뛰었고, 데몬이 꺼진 사이 끝난 claude 세션의 열린 턴은 Stop 도 idle 타이머(턴 종료에만
  arm)도 없이 아무도 닫지 않았다 — 두 run 이 재시작 후 17시간째 열려 있었다. 첫 훅이 오기
  전까진 `rehydratedSessions` 에 남고 `isLiveRun` 은 거짓 → 2시간 reaper 가 가져가며
  `releaseRun` 으로 메모리 엣지도 함께 버린다(닫힌 행에 후속 턴을 쓰지 않도록).
- **에이전트 자신의 기록이 그 턴을 닫는다.** rehydrate 시 codex 는 rollout, claude 는 transcript
  (`claudeTurnCompletionSince` — `~/.claude/projects/<cwd-slug>/<sid>.jsonl`, slug 추측 후 전체
  스캔)를 읽어 `end_turn` 이면 그 기록의 시각에 응답과 함께 `synthetic_stop`, `stop_sequence`
  면 `aborted`, 인터럽트 마커면 `interrupted` 로 닫는다. 꼬리가 `tool_use` 면 아무 주장도 하지
  않는다(세션이 살아 있을 수 있다). `closeTurn(…, endedAt)` 은 데몬이 꺼져 있던 시간을 누구의
  턴 길이에도 넣지 않는다.
- **codex 의 next_prompt 는 대부분 유실이 아니었다.** 7일간 next_prompt 로 닫힌 codex 턴 23건을
  rollout 으로 재조사: 16건은 완료 응답이 있었고(Stop 만 유실), 2건은 API 오류(`task_complete.
  error` — Codex 는 이때 Stop 을 아예 안 쏜다), 5건만 흔적 없음. 다음 프롬프트가 열릴 때
  `codexCompletionProbe` 로 같은 판정을 내려 응답·Codex 의 종료 시각과 함께 `synthetic_stop`
  또는 `aborted` 로 닫고, 진짜 유실(5건)만 `next_prompt` 에 남긴다. stop-health 의 codex
  손실률은 그만큼 내려간다(측정 전 15%).
- **run 이 닫힌 뒤 도착한 응답도 그 턴에 붙는다.** 단일 턴 워커(`claude -p`) 는 Stop 뒤
  80–130ms 에 SessionEnd 를 보내 run 을 닫고, 지연 transcript 재읽기(1.5s) 는 그 뒤에 도착해
  `sessionToLastTurnId` 가 없어 버려졌다 — 하루 13건 중 6건. `setLastClosedTurnResponse` 가
  store 의 `latestClosedTurnIdForSession`(60초 창, `idx_runs_session`) 으로 폴백한다. 30일
  창의 단일 턴 무응답 57건 중 53건은 transcript 로 백필했다.
- **judge 백로그가 멈추는 두 경로.** (1) 드레인이 30초마다 3건을 동시 투입했고 로컬 MLX 는
  직렬이라 60초 호출 타임아웃을 넘긴 태스크마다 2회 실패 → 프로세스 수명 동안 보류, 로그엔
  한 줄도 없었다(23–00시 283건 → 이후 0, 289건 pending). 이제 판정 중인 호출이 없을 때만
  1건(`APME_TASK_JUDGE_DRAIN_PER_TICK`), 보류는 30분 후 만료(`TASK_EVAL_PARK_MS`), 보류
  1·10·100번째마다 마지막 실패 사유를 `log` 로 남긴다. (2) 백엔드 프로브는 시작 시 한 번뿐이라
  그 순간 남의 추론으로 바쁜 MLX 가 8초 안에 답하지 못하면 프로세스 수명 동안 드레인이 꺼졌다
  — 실측된 상태였다. `unavailable` 이면 5분마다 재프로브(`APME_JUDGE_REPROBE_MS`)하고 복귀를
  로그한다.

게이트: `apme-rehydrate.test.ts`(임시 채택·transcript/rollout 닫기·releaseRun),
`apme-collector.test.ts`(codex next-prompt 회수·늦은 응답 창), `apme-claude-turn-completion.test.ts`,
`codex-rollout-response.test.ts`(실패 완료), `apme-task-boundary.test.ts`(보류 만료).

**후속 라이브 측정(2026-09-04 07:56 KST).** 체크아웃 데몬 build `cbf78061aa2e`가
13개 open run(8 task, 8 open turn)을 재수화했고, 그 자리에서 3개 turn을 에이전트 기록으로
닫았다. MLX `/v1/models`는 30ms에 HTTP 200, health probe는
`gemma-4-26b-a4b-it-4bit` ready(1.165s)로 회복했으며 22시 UTC 한 시간에 task 6건을 새로
판정했다. 30일 backlog는 이전 301→현재 250, 전체 task judge는 808(30일 595)이다.
commit `5ad609cf` 뒤 codex closed turn 표본은 stop 4/4가 모두 응답을 가져 응답 소스는
정상이나, 새 `next_prompt` 표본은 아직 0이라 그 복구 분기의 잔여 손실률은 더 쌓여야 한다.
같은 이유로 이번 재시작 뒤 2시간이 지나지 않아 provisional adoption reaper의 새 실물 표본은
아직 없다(회귀 테스트는 통과). 반면 P5 producer는 재시작 74초 뒤 다른 Claude 세션의 실제
child completion을 `sample_events(kind='subagent')`로 기록했고, 같은 task의
`model_config.subagents`와 `/apme/graph`의 subagent 노드·`delegated` 엣지를 실물로 확인했다.

**Swift 데몬 미러 상태(2026-09-04).** 순수 규칙인 gradeability 는 계획대로
`generate-apme-display-rules` 가 `TaskGradeabilityRules.generated.swift` 를 생성하고,
Node/Swift 가 `shared/task-gradeability-vectors.json` 을 같이 리플레이한다. Swift
`ApmeRunner` 는 judge 호출 전에 같은 `no_reply`/`aborted_only`/`trivial` 판정을 적용해
`notes_json.notGradeable` 을 남긴다. 백로그 드레인과 rehydrate 는 데몬 상태 기계라 여전히
생성 대상이 아니며, Swift 데몬에 포팅할 때 `boundary_signal`/`end_source` 스탬프를 별도
공유 벡터로 고정한다.

**잔여 개선안 현황(2026-09-04).** P5(a)(b)는 완료했다. Node
`SubagentTimelineTracker` 와 Swift `subagentCensus` 가 자식 hook 을 일반 APME 경로보다 먼저
소비한 뒤, lifecycle 증거만 활성 부모 task 에 명시적으로 handoff 한다. 이 producer 가
`sample_events.kind='subagent'` 와 `SampleModelConfig.subagents` 를 같이 채우며, 모델/사용량
후속 hook 은 기존 model_config 를 병합해 그 값을 지우지 않는다. task judge rollup 은 자식의
start/completion·duration·summary 를 읽고, 양 데몬의 `/apme/graph` 는 한 subagent 노드와
`delegated` 엣지로 투영한다. 활성 부모 task 가 없으면 가장 최근 세션을 추측하지 않고 기록을
거부한다. P6 evidence tier 는 여전히 미착수다. `/apme/pareto`·`/apme/recommend` 는 대시보드 Recommend 탭이
쓰지 않아 "죽은" 라우트로 보이지만 Daemon HTTP API 표에 문서화되고 `apme-http.test.ts` 가
고정하는 외부 표면이므로 유지 — 대시보드가 scorecard 로 자체 계산하는 것과 라우트가 같은
`pareto.ts` 를 공유하는지는 다음에 라우트를 만질 때 확인한다.

## Settings

`~/.agentdeck/settings.json` 의 `apme` 블록:

```json
{
  "apme": {
    "enabled": true,
    "deterministic": {
      "enabled": true,
      "timeoutSec": 180,
      "commands": {
        "typescript": {
          "lint": "pnpm lint",
          "build": "pnpm build",
          "test": "pnpm vitest run --reporter=json"
        }
      }
    },
    "judge": {
      "backend": "mlx",
      "model": "qwen3-30b",
      "sampleRate": 1.0,
      "onlyWhenDisagreement": false,
      "fallbackToFoundationModels": true,
      "fallbackToMlx": true,
      "endpoint": "http://127.0.0.1:8800/v1/chat/completions"
    },
    "availableModels": ["claude-opus-4-6", "claude-sonnet-4-6", "qwen3-30b"]
  }
}
```

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | APME 전체 on/off |
| `deterministic.enabled` | `true` | Layer 1 (lint/build/test) 실행 여부 |
| `deterministic.timeoutSec` | `180` | 단계별 하드 타임아웃 (초) |
| `deterministic.commands` | `{}` | 언어별 명령 override |
| `judge.backend` | `"mlx"` | `"mlx"` \| `"foundationModels"` \| `"openai"` \| `"openclaw"` \| `"api"` |
| `judge.model` | `"qwen3-30b"` | 백엔드에서 사용할 모델 id. `qwen3-30b`는 legacy placeholder 로 취급되고, 실제 MLX fallback 은 `mlx-community/Qwen3-1.7B-4bit` |
| `judge.sampleRate` | `1.0` | judge 호출 비율 (0..1) — 로컬 backend는 비용 0이므로 전수 평가 기본 |
| `judge.onlyWhenDisagreement` | `false` | `true`면 결정론 clear pass는 judge skip |
| `judge.fallbackToMlx` | `true` | `backend:"foundationModels"` 일 때 FM 경로가 없으면 MLX 로 재시도 |
| `judge.fallbackToFoundationModels` | `true` (기본값일 때만) | MLX 서버가 응답하지 않으면 온디바이스 FM 으로 재시도. **사용자가 `backend` 를 직접 적으면 꺼진다** — 명시한 백엔드가 죽어 있으면 조용한 강등 대신 보이는 skip |
| `availableModels` | `[]` | 추천 엔진이 필터할 가용 모델 목록 |

## HW sampler

`ApmeHwSampler.snapshot()` — macOS only, `runs.hw_profile`에 JSON 저장:

```json
{
  "platform": "darwin",
  "memTotal": 68719476736,
  "memUsed": 32145678336,
  "cpuLoad": 0.23,
  "cpuCount": 12,
  "model": "Mac14,14",
  "timestamp": 1712880000000
}
```

`sysctl hw.memsize`, `vm_stat` (active+wired+compressed pages), `uptime` load average, `sysctl hw.model`. 권한 상승 없음.

## Optional dependency

`better-sqlite3`는 bridge의 **optional** native dep. 미설치 시:

- `ApmeStore.init()` → `false` → `initApme()` → `null`
- `BridgeCore.setApme(null)` → 모든 collector 호출 no-op
- bridge 정상 부팅, APME만 비활성

설치: `pnpm install` (pnpm `onlyBuiltDependencies`에 등록됨). 모듈 해석은 `createRequire(import.meta.url)` 사용 — vitest가 repo root에서 실행돼도 `bridge/node_modules/better-sqlite3` symlink를 따라감.

## Test coverage

| File | Tests | Coverage |
|---|---|---|
| `apme-collector.test.ts` | 9 | run lifecycle, usage/model update, listRuns, rubric seed, evals, scorecard, multi-turn 사이클, setLastClosedTurnResponse fallback, disabled graceful |
| `apme-classifier.test.ts` | 17 | computeSignals (tool counts, plan mode, web search), classifyRun (coding/planning/research/debugging/refactoring/review/conversation/ops/unknown), classifyRunSmart (LLM fallback) |
| `apme-runner.test.ts` | 20 | detectLanguage, parseJudgeJson, shouldJudge gating, runner flow (mock det+judge), real spawn, no-changes skip, buildJudgePrompt, enqueueTurn |
| `apme-tuner.test.ts` | 19 | correlation math, parseProposal, extractOverall, disagreement collection, vibeCorrelation, tune accept/reject/unparseable/insufficient/disabled |
| `apme-http.test.ts` | 10 | 503 uninit, GET runs/run/scorecard/rubric, POST vibe/recommend, 404, agent filter |

**총 75 tests.** 모든 테스트는 실제 SQLite (`better-sqlite3` `createRequire` 해석) + 실제 `spawn` 명령 실행.

## Schema versioning — `agentdeck-eval/v1`

APME 의 외부 노출 데이터는 **`agentdeck-eval/v1`** 라는 안정 계약을 따른다. 외부 도구(자체 dashboard, exporter 스크립트, 미래 통합) 가 안심하고 소비할 수 있도록 버전을 고정한다.

### 어디에 사는가

- 타입 정의: [`shared/src/eval-schema.ts`](../shared/src/eval-schema.ts) — `@agentdeck/shared` 에서 export.
- 버전 상수: `EVAL_SCHEMA_VERSION = 'agentdeck-eval/v1'`
- 모든 GET HTTP 응답 본문에 `schema` 필드가 포함된다 — 예: `GET /apme/runs` → `{ "schema": "agentdeck-eval/v1", "runs": [...] }`. POST write-ack 응답(`/apme/vibe`, `/apme/tune` 등) 은 envelope 미포함.
- bridge 내부 `bridge/src/apme/types.ts` 는 shared 의 type 을 그대로 re-export — 동일한 contract 위에서 동작.

### 버전 규칙

| 변경 종류 | 버전 |
|---|---|
| 새 optional 필드 추가 | v1 유지 (additive) |
| 새 axis (rubric 안에서) 추가 | v1 유지 |
| 새 카테고리 / 새 boundary signal | v1 유지 |
| 새 layer (`task_judge` 같은 enum 값 추가) | v1 유지 |
| 기존 필드 이름 변경 / 제거 | **v2 필요** |
| 기존 필드의 의미·타입 변경 | **v2 필요** |
| 응답 envelope 의 키 구조 변경 | **v2 필요** |

v2 가 필요할 때는 `EVAL_SCHEMA_VERSION` 을 bump 하고, 한 메이저 사이클 정도는 양쪽 schema 를 동시에 노출해 외부 소비자에게 마이그레이션 시간을 준다.

### 핵심 타입 (요약)

| Type | 의미 |
|---|---|
| `ApmeRunRow` | 한 세션. `compositeScore`, `taskCategory`, `outcome`, `agentType` 포함 |
| 개별 turn row | turn(Q&A) 단위. `prompt`, `response`, `efficiency_json` |
| `ApmeTaskRow` | turn 들을 boundary signal 로 묶은 단위 — `todo_complete` / `clear` / `session_end` |
| `ApmeStepRow` | 모든 hook event 원본 로그 |
| `ApmeEvalRowDb` | layer 별 axis 점수 + `raw` (JSON judge 출력) |
| `ApmeRubricRow` | versioned rubric (general / 7개 category 별 / `task_rollup`) |
| `ApmeVibeRow` | 사용자 라벨 (`approve` / `reject` / `neutral`) |
| `ParsedJudge` | judge LLM JSON 응답의 파싱 결과 — `scores`, `reasoning`, `done`, `missed`, `summary` |

### Judge JSON 계약

Layer 2 judge 는 `parseJudgeJson()` ([runner.ts](../bridge/src/apme/runner.ts)) 가 받는 strict JSON 을 출력한다:

```json
{
  "task_completion": 0.85,
  "code_quality": 0.8,
  "efficiency": 0.7,
  "overall": 0.82,
  "reasoning": "...",
  "done": ["item1", "item2"],
  "missed": ["item3"]
}
```

axes 이름은 rubric 별로 다르다 (general / conversation / planning / research / debugging / refactoring / review / ops / task_rollup). 모든 axes 점수는 `[0,1]` float, judge 가 0–10 으로 반환하면 `parseJudgeJson` 이 자동 정규화. `task_rollup` 만 `summary` 필드를 추가로 가진다.

### OTel / 외부 표준화 정책

이 schema 는 **OTel 호환이 목표가 아니다.** judge axes / vibe / composite_score 는 OpenTelemetry GenAI semantic conventions 에 1급 시민으로 매핑되지 않는다. lifecycle 정렬은 별도의 internal envelope (`shared/src/telemetry-envelope.ts`) 가 담당한다 — 자세한 근거: [otel-standardization-study.md](otel-standardization-study.md).
