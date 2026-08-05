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

**비용 정책**: judge 백엔드는 App Store Swift daemon 에서는 **Apple Intelligence Foundation Models** 기본, CLI-only 경로에서는 Swift daemon proxy 를 먼저 쓰고 없으면 내장 Swift helper 로 Foundation Models 를 호출한다. 둘 다 불가능하면 **MLX**(`mlx-community/Qwen3-1.7B-4bit` fallback) / OpenClaw Gateway 를 사용한다. 모든 run을 평가해도 비용이 0이 되도록 설계.

> **관련 문서**
> - [why-apme.md](./why-apme.md) — 왜 APME를 만들었는가 (설계 의도, 카테고리별 평가 전략)
> - [apme-pipeline.md](./apme-pipeline.md) — 8 레이어 파이프라인 심층 해설 (file:line 앵커 포함)

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Agent Sessions                                │
│  claude-code (PTY+hook) │ openclaw/opencode (GW) │ codex-cli (PTY)   │
└───────┬─────────────────┴────────┬────────────────┴──────┬───────────┘
        │ hook POST                │ timeline events       │ parser events
        ▼                          ▼                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  wireAgentApme() + PTY tail parser  (bridge/src/index.ts)            │
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

- **Session bridge** (`agentdeck claude/codex/opencode/monitor`): 세션 시작~종료 동안 runs, turns, steps, usage, git diff artifact 를 SQLite에 기록. 세션 종료 시 eval 은 실행하지 않음 (프로세스가 2초 내 exit).
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
| `bridge/src/apme/collector.ts` | 수집 경계 — session/turn lifecycle, hook → steps, PTY response → turns |
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
- **투영으로 유도하는 것** — session / project / model / agent / tool / file 은 행이 아니라 컬럼·payload 이므로 `bridge/src/apme/graph.ts` 가 노드로 materialize 한다. 특히 **file 노드**는 tool payload 의 `file_path` 에서 뽑아 run 의 `project_path` 기준 상대경로로 키잉하므로, 같은 파일을 worktree 와 본 체크아웃에서 만졌어도 한 노드로 합쳐진다. 커버리지는 부분적이다(경로를 받지 않는 Bash/WebFetch 등) — `stats.fileCoverage` 가 그 비율을 그대로 보고한다.

모델 정의는 `shared/src/apme-graph.ts`(SSOT), 빌더는 `bridge/src/apme/graph.ts`, 노출은 `GET /apme/graph`, 뷰어는 대시보드 **Graph** 탭(외부 라이브러리 없이 canvas force layout — 대시보드는 self-contained HTML 이라 CDN 을 못 쓴다).

투영은 파생물이며 저장하지 않는다 — 마이그레이션 없이 형태를 바꿀 수 있다.

### turns — 멀티턴 세션의 개별 턴

```
id, run_id, turn_index, prompt, response,
started_at, ended_at, tool_calls,
files_modified, files_created,
git_before, git_after,
task_category, outcome, composite_score, efficiency_json
```

턴은 `UserPromptSubmit`/`chat_start`/`user_prompt` 이벤트마다 생성되고, 응답 캡처 시 `response` 채워짐. 다음 턴 시작 또는 세션 종료 시 `closeTurn()` 호출.

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
2. **Claude Code**: `adapter.on('event', 'hook')` → `apme.collector.ingestHook(sessionId, event, data)`
3. **Non-Claude 에이전트** (OpenClaw/OpenCode/Codex): `wireAgentApme(adapter, agentType, apme, core, ptyRingBuffer)` — timeline 이벤트 + PTY parser 이벤트를 collector로 변환
4. **Claude Code PTY 응답 캡처**: `spinner_stop` 이벤트 + 500ms 지연 → 링버퍼 tail에서 `⏺` 마커 기반 파싱 → `setTurnResponse()`. `pendingPtyResponse` 3-path race 해결

> **관측(observed) 세션의 응답 캡처는 데몬 쪽에 따로 있다.** 위 PTY 경로는 `agentdeck claude` 로 띄운 managed 세션 전용이라, 직접 실행한 `claude`/`codex`/`opencode` 는 이 경로를 타지 않는다. 그 결과 hook 으로만 관측되는 세션은 프롬프트와 툴 궤적만 아카이빙되고 **응답은 통째로 유실**됐다 (claude-code turn 1589개 중 response 219개, 마지막이 2026-07-11; `assistant_message` 궤적 이벤트는 전 기간 15개뿐이고 그중 12개가 OpenClaw). 대시보드가 TIMELINE 이 온전히 보여주는 대화를 재현할 수 없었고, judge 는 침묵을 채점하고 있었다. 지금은 `daemon-server.ts` 의 stop 훅 핸들러가 타임라인 행을 결정하는 **같은 분기에서** `setTurnResponse()` 를 호출한다. Swift 데몬도 같은 증상이었지만 원인이 달랐다 — `getLastEntry(type:"chat_end")` 를 읽었는데 `chat_end` 는 응답이 **없을 때만** 나오는 행이라 구조적으로 응답을 볼 수 없었다(`DaemonServer.appendClaudeCodeChatEnd` 로 이동).
5. `usage_info` 메타데이터 → `apme.collector.updateUsage(sessionId, snapshot)`
6. `state_changed` → `apme.collector.updateModel(sessionId, modelName)`

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
  5. **abandoned run 수확** — 4번이 볼 수 없는 것들. 데몬이 재시작하면 in-memory `sessionToRun` 맵이 사라져 진행 중이던 run 이 영원히 `ended_at IS NULL` 로 남는다. 이들은 실제 프롬프트·턴·툴 궤적을 갖고 있어 4번의 빈-껍데기 술어를 통과하지 못하고, **task 도 닫히지 않으므로 평가가 아예 돌지 않는다** (실측: open task 65 vs closed 9). 마지막 활동 시각 기준 2시간 무활동(`AGENTDECK_APME_ABANDON_SEC`)이면 turn/task/run 을 **그 마지막 활동 시각으로** 닫고(`boundary_signal='orphaned'`), 응답 텍스트가 있는 task 만 judge 에 enqueue 한다. `collector.isLiveRun()` 으로 자기 프로세스가 아직 쥐고 있는 run 은 건너뛴다
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
| GET | `/apme/runs?limit=&agent=&model=` | 최근 runs + evals + overallScore |
| GET | `/apme/run/:id` | 단일 run 상세 (steps, turns, per-turn evals, vibe) |
| GET | `/apme/tasks?limit=&offset=&agent=&project=&category=&outcome=&state=&q=` | **처리된 task 단위 전체 목록** (paged + faceted) |
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
      "backend": "foundationModels",
      "model": "qwen3-30b",
      "sampleRate": 1.0,
      "onlyWhenDisagreement": false,
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
| `judge.backend` | `"foundationModels"` | `"foundationModels"` \| `"mlx"` \| `"openclaw"` \| `"api"` |
| `judge.model` | `"qwen3-30b"` | 백엔드에서 사용할 모델 id. `qwen3-30b`는 legacy placeholder 로 취급되고, 실제 MLX fallback 은 `mlx-community/Qwen3-1.7B-4bit` |
| `judge.sampleRate` | `1.0` | judge 호출 비율 (0..1) — 로컬 backend는 비용 0이므로 전수 평가 기본 |
| `judge.onlyWhenDisagreement` | `false` | `true`면 결정론 clear pass는 judge skip |
| `judge.fallbackToMlx` | `true` | CLI에서 Swift daemon Foundation Models endpoint가 없을 때 MLX로 fallback |
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
