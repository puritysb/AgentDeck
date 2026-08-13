# APME Pipeline — 세션 수집부터 평가·렌더링까지

> [apme.md](./apme.md)가 **"APME가 무엇인가"**를 설명한다면, 이 문서는 **"데이터가 어떻게 흐르는가"**를 파이프라인 단계별로 정리한다. 모든 파일 참조는 `bridge/src/apme/` 기준이며 file:line 앵커로 역추적 가능하다.

---

## 파이프라인 개요 (8 레이어)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         AGENT SESSIONS (3 ingestion paths)                   │
│                                                                              │
│  ┌──────────────┐    ┌──────────────────┐    ┌────────────────────────────┐  │
│  │ claude-code  │    │ openclaw/opencode│    │ codex-cli                  │  │
│  │ (lifecycle   │    │ (timeline events)│    │ (lifecycle hooks + notify  │  │
│  │  hooks +     │    │                  │    │  turn-complete + rollout   │  │
│  │  transcript) │    │                  │    │  JSONL)                    │  │
│  └──────┬───────┘    └────────┬─────────┘    └────────────┬───────────────┘  │
│         │                     │                           │                  │
│         │ HTTP POST           │ adapter.on('event')       │ HTTP POST        │
│         │ /hooks/:event       │ source:'timeline'         │ /hooks/codex_*   │
└─────────┼─────────────────────┼───────────────────────────┼──────────────────┘
          │                     │                           │
          ▼                     ▼                           ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ L1  INGESTION              │  claudeHookToSpans / wireAgentApme()            │
│                            │  bridge/src/index.ts (hook switch + codex      │
│                            │  turn manager)                                  │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ L2  COLLECTOR → STORE      │  ApmeCollector + ApmeStore                      │
│                            │  openRun → ingestHook → setTurnResponse →       │
│                            │  closeTurn → closeRun                           │
│                            │  ~/.agentdeck/apme.sqlite (WAL mode)            │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │
           ┌───────────────────┼───────────────────┐
           ▼                   ▼                   ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│ L3 CLASSIFIER    │ │ L4 RUNNER        │ │ L5 TUNER         │
│ rules → LLM      │ │ det + judge      │ │ rubric auto-tune │
│ classifier.ts    │ │ runner.ts        │ │ tuner.ts         │
│ (30s orphan loop)│ │ (turn + run)     │ │ (OPRO loop)      │
└────────┬─────────┘ └────────┬─────────┘ └────────┬─────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ L6  RECOMMENDER            │  scorecard 기반 모델 제안  (recommend.ts)        │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ L7  HTTP + WS BROADCAST    │  GET /apme/*  +  apme_eval WS  +  timeline      │
│                            │  apme/http.ts, daemon-server.ts                 │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ L8  DEVICE RENDERING       │  ★ eval_result timeline entry                   │
│                            │  Stream Deck / Apple / Android / ESP32          │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## L1 — 데이터 인제스트 (에이전트별 3경로)

APME는 **에이전트가 무엇을 했는지**를 3가지 서로 다른 소스에서 수집한다. 각 경로는 같은 `ApmeCollector` API (`ingestHook`, `setTurnResponse`)로 수렴된다.

### 1A. Claude Code — Hook POST

가장 신뢰도 높은 경로. Claude Code가 설치한 훅이 bridge HTTP 엔드포인트로 이벤트를 POST한다.

- **훅 이벤트**: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`
- **엔드포인트**: 각 세션 브리지의 `/hook/:event` (포트 9121+)
- **흐름**:
  ```
  Claude Code → HTTP POST → hook-server.ts → collector.ingestHook()
  ```
- **앵커**: `bridge/src/index.ts` hook 라우팅 + `collector.ts:86` (`ingestHook`)

### 1B. OpenClaw / OpenCode — Timeline Events

PTY가 없거나 구조화된 이벤트 스트림이 있는 에이전트는 timeline 이벤트를 APME 이벤트로 변환한다.

- **소스**: `adapter.on('event', { source: 'timeline', entry })`
- **매핑** (`bridge/src/index.ts:1181-1209`):

  | Timeline Entry     | APME 변환                                      |
  |---|---|
  | `chat_start`       | `ingestHook(UserPromptSubmit)` — 프롬프트 수집 |
  | `chat_response`    | `setTurnResponse()` — 응답 저장                 |
  | `chat_end`         | `setLastClosedTurnResponse()` (fallback)        |
  | `tool_request`     | `ingestHook(PreToolUse, { tool_name })`        |
  | `tool_resolved`    | `ingestHook(PostToolUse, {})`                  |

- **앵커**: `bridge/src/index.ts:1169` (`wireAgentApme`), `:1181` (timeline 분기)

### 1C. Codex CLI — Lifecycle Hooks + Notify + Rollout

Codex 수집은 `~/.codex/config.toml` 의 lifecycle hook (`codex_session_start` /
`codex_user_prompt_submit` / `codex_tool_start` / `codex_tool_end` /
`codex_stop`) 이 1차 경로다. 초기 구현이 쓰던 PTY 파서 turn 추적은 1.0.19 에서
제거됐다 (화면 파싱은 lifecycle 정본이 아니다).

- **소스**: `adapter.on('event', { source: 'hook', event: 'codex_*' })` →
  `CodexTurnManager.onHookEvent()` (`bridge/src/apme/adapters/codex-turn-manager.ts`)
- **턴 경계**: `codex_user_prompt_submit` 이 열고 `codex_stop` 이 닫는다.
  `codex_stop` 이 유실되면 notify `codex_turn_complete` 가 같은 턴을 닫고
  StateMachine 도 IDLE 로 복구한다 (hook 과 notify 는 둘 다 curl/`AGENTDECK_PORT`
  경로를 타므로, 세션 내내 양쪽 모두 침묵하면 `codex-hook-silence.ts` 가 경고를
  타임라인에 남긴다)
- **응답 수집**: inline payload (`last_assistant_message` 등) 우선, 없으면
  rollout JSONL tail (`bridge/src/codex-rollout-response.ts`)
- **오류 표기**: 명시적 `error` 키만 오류로 매핑한다 — `message` 는 다른 Codex
  이벤트에서 콘텐츠를 담는 키라 오류로 해석하지 않는다 (실측 codex_stop 311건
  기준 두 키 모두 등장 0회)

### 1D. Claude Code Response Capture (transcript 정본)

Claude Code 의 응답 본문은 `Stop` hook payload 의 `transcript_path` JSONL tail
에서 읽는다 (`readClaudeTranscriptLastTurn` — `last_assistant_message` 필드는
불안정해 transcript 가 닿지 않을 때의 보조로만 쓴다).

`Stop` hook 자체가 유실되는 경우가 실측으로 존재하므로 (v2.1.104 에서 발화율
~18% 를 기록한 적이 있고, 2.1.231 에서도 유실이 관측된다) **transcript
watchdog** (`bridge/src/claude-turn-watchdog.ts`) 이 구조적 fallback 이다:

```
턴 열림(UserPromptSubmit) 상태에서 hook 채널이 10s+ 침묵
  → transcript tail 프로브 (mtime 게이트, 512KB cap)
  → 마지막 message 레코드가 assistant + stop_reason "end_turn"
    이고 timestamp 가 턴 시작 이후면 턴이 끝났다는 증거
  → synthetic Stop 을 어댑터 이벤트 파이프에 주입
  → 상태머신·타임라인·APME 가 기존 Stop 경로로 일관되게 닫힘
```

`stop_reason: "tool_use"` (권한 프롬프트/AskUserQuestion 대기) 는 절대 완료로
판정하지 않으므로 진짜 대기를 강제로 닫는 일은 없다. 늦게 도착한 실제 Stop 은
`ccPendingCompletion` 가드가 dedup 한다. 어느 단계에도 화면(PTY) 파싱은 없다.

---

## L2 — Collector & Store

### ApmeCollector (`bridge/src/apme/collector.ts`)

**인메모리 세션 매핑** (`collector.ts:49-52`):
- `sessionToRun: Map<sessionId, runId>` — 세션당 현재 run
- `sessionToTurn: Map<sessionId, ActiveTurn>` — 세션당 활성 턴
- `sessionToLastTurnId: Map<sessionId, turnId>` — closeTurn 후에도 남아있어 race 수정용 fallback

**주요 메서드**:

| 메서드 | 호출 시점 | 하는 일 |
|---|---|---|
| `openRun(input)` `:60` | 세션 시작 | `runs` row 생성, `gitBefore` 캡처 |
| `ingestHook(sessionId, event, data)` `:86` | 훅/이벤트 도착 | `steps` row 기록, turn lifecycle 관리 |
| `setTurnResponse(sessionId, response)` `:183` | 응답 캡처 | 활성 turn에 response 저장 (max 10K) |
| `setLastClosedTurnResponse(sid, r)` `:196` | fallback | 직전에 닫힌 turn의 비어있는 response 채움 |
| `closeTurn(sessionId)` `:149` | 새 `UserPromptSubmit` 또는 종료 | turn 종료, `gitAfter` 기록 |
| `splitRun(sessionId)` `:239` | `/clear` 감지 | 현재 run 닫고 새 run 시작 |
| `closeRun(sessionId, exitCode)` `:268` | 세션 종료 | run 종료, diff artifact 저장, async `classifyRunSmart()` |

### ApmeStore — SQLite 스키마 (`store.ts:32-174`)

SQLite WAL 모드, `~/.agentdeck/apme.sqlite`.

```sql
runs            ── 18 컬럼: id, session_id, agent_type, model_id,
                            project_{name,path}, task_prompt,
                            started_at, ended_at,
                            input_tokens, output_tokens, cost_usd, exit_code,
                            git_{before,after}, hw_profile,
                            task_{signals,category,category_source},
                            outcome, outcome_confidence,
                            efficiency_json, composite_score

turns           ── id, run_id, turn_index, prompt, response,
                   started_at, ended_at, tool_calls,
                   files_{modified,created}, git_{before,after},
                   task_category, outcome, composite_score, efficiency_json

steps           ── id, run_id, ts, kind, tool_name, payload(JSON)
                   (이벤트 원본 로그 — UserPromptSubmit/PreToolUse/…)

artifacts       ── run_id, kind, path, sha256, bytes
                   (git diff 등 run 종료 시 저장되는 파일)

evals           ── id, run_id, turn_id, layer, metric, score,
                   raw(JSON reasoning), rubric_ver, judge_model, created_at

rubrics         ── version(PK), purpose, prompt, weights(JSON),
                   created_at, parent_ver, notes

vibe_feedback   ── run_id, verdict('approve'|'reject'|'neutral'), note, ts
```

**집계 뷰** (`store.ts:137-174`):

- `v_run_metrics` — run별 `overall` + `tests_pass` 단일값 (MAX로 축약)
- `v_model_scorecard` — (agent_type, model_id) 그룹: runs, avg_overall, avg_tests_pass, total_cost, cost_per_quality
- `v_category_scorecard` — (task_category, model_id) 그룹: runs, avg_overall, avg_tests_pass, total_cost

**기본 루브릭 시드** (`store.ts:178-315`):
- `DEFAULT_RUBRIC_V1`: general (task_completion/code_quality/efficiency/overall)
- `CATEGORY_RUBRICS`: conversation, planning, research, debugging, refactoring, review
- `ops`는 별도 루브릭 없이 general로 fallback

> **버그 노트**: 2026-04-13 기준, `rubrics.version`은 PK이므로 category rubrics를 `version=1`로 INSERT하면 충돌한다. 해결: category 루브릭은 `version` 컬럼을 생략하여 SQLite rowid autoincrement를 사용 (`store.ts:434-438`).

---

## L3 — Classifier (Task Category 분류)

에이전트 세션이 코딩인지, 대화인지, 조사인지 자동 판별한다. **Runner의 루브릭 선택**이 이 분류에 의존한다.

### Signals 계산 (`classifier.ts:64-147`)

Run의 steps 테이블을 훑어서 `TaskSignals` 구조체를 만든다:

```
toolCounts         — 툴별 호출 횟수 히스토그램
dominantTool       — 최다 호출 툴 이름
totalToolCalls     — 전체 툴 호출 수
turnCount          — 턴 개수
sessionDurationSec — 세션 경과 시간
promptLengthChars  — 총 프롬프트 길이
planModeUsed       — Plan mode 진입 여부
permissionRequests — 권한 프롬프트 횟수
diffReviews        — diff 리뷰 횟수
filesCreated/Modified
testCommandsRun    — Bash에서 npm test / pytest 등 감지
webSearches, agentDelegations, isAutomated, ocToolNames
```

### 규칙 기반 분류 (`classifier.ts:159-208`)

우선순위 순서대로 7개 카테고리에 매핑:

| Priority | Category | 조건 |
|---|---|---|
| 1 | `multi_agent` | ≥2 delegations |
| 2 | `planning` | plan mode 사용 |
| 3 | `conversation` | ≤2 tools, <120s |
| 4 | `planning` | 1-3 turns, 파일 변경 없음 |
| 5 | `research` | web search + grep/glob 조합 |
| 6 | `debugging` | tests + edits + bash 조합 |
| 7 | `refactoring` | >50% Edit, 3+ 파일 수정 |
| 8 | `coding` | Edit/Write + 파일 변경 |
| 9 | `review` | >50% Read, ≥5 tools, ≤1 파일 수정 |
| 10 | `ops` | >50% Bash |
| — | `unknown` | 위 어디에도 해당 없음 |

### LLM fallback (`classifier.ts:239-317`)

규칙이 `unknown`이면 로컬 MLX에 prompt + tool 요약을 넣어 분류 요청.

### classifyRunSmart

**엔트리 포인트**: `classifyRunSmart(store, runId)` (`classifier.ts:299`)
→ rules 먼저 → unknown이면 LLM → `{ signals, category, source: 'rule'|'llm' }` 반환

### Daemon 재분류 루프 (`daemon-server.ts:971-980`)

데몬은 30초마다:
1. 미평가 runs를 evaluation 큐에 enqueue
2. 10초 이상 닫힌 run의 outcome 계산
3. **`task_category IS NULL`인 run을 재분류** — 세션 프로세스가 일찍 kill되어 async classify가 중단된 경우를 복구
4. orphan run 태깅

---

## L4 — Runner (결정론적 + LLM Judge)

### 2-Layer 평가 구조 (`runner.ts`)

#### Layer 1 — 결정론적 검증 (`runner.ts:201-233`)

프로젝트 언어 감지 (TypeScript/Swift/Kotlin) 후 타임아웃과 함께 lint/build/test 실행:

```
evals (layer='deterministic'):
  - lint_clean     0 or 1
  - build_ok       0 or 1
  - tests_pass     0 or 1
```

#### Layer 2 — LLM Judge (`runner.ts:235-270`)

Gated: `shouldJudge(cfg.judge, layer1Passed)`가 true일 때만 실행.

**루브릭 선택** (`store.getCurrentRubric(run.taskCategory)`):
- 분류된 카테고리 전용 루브릭이 있으면 사용
- 없으면 `general` fallback

**Judge 호출** → JSON 응답 파싱 → 축(axis)별 score `evals` 테이블에 저장 (`layer='llm_judge'`).

### 턴 단위 즉시 평가 (`runner.ts:102-169`)

**Mid-session turn eval**: 세션이 끝나기 전, 각 턴 완료 직후에 실행.

```
enqueueTurn({ runId, turnId, category })
  → rubric 선택 (category → 'conversation' fallback)
  → turn prompt + response만 judge에 입력 (전체 diff 없음)
  → evals 테이블에 layer='turn_judge' + turn_id 연결
  → onResult() 콜백 fire
```

**코딩 카테고리는 제외** — git diff가 있어야 제대로 된 평가가 가능하므로 세션 종료 후 run-level eval만 수행. 비코딩(conversation/planning/research/review)은 턴마다 즉시 평가.

### Judge 백엔드 (`runner.ts:501-576`)

| Backend | 엔드포인트 | 역할 |
|---|---|---|
| `mlx` | `127.0.0.1:8800/chat/completions` | **기본** — 로컬, 비용 0 |
| `openclaw` | `127.0.0.1:18789/chat` | 보조 — 로컬 gateway 경유 |

### Outcome 계산 (`outcome.ts:75-160`)

**Non-coding** (conversation/planning/research/review): 응답이 캡처되었는가 → success=1.0 (committed).

**Coding**: git 상태로 outcome 분기:

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

### Composite Score (`outcome.ts:47-57`)

가중 합:
```
composite = 0.40 × outcomeScore
          + 0.40 × judgeScore (overall)
          + 0.15 × efficiencyScore
          + 0.05 × vibeScore
```

`efficiencyScore`는 `tokensPerChange`, `costPerChange`, `timeToCompleteSec`, `toolEfficiency`로 산출 (`outcome.ts:37-43`).

---

## L5 — Rubric Auto-Tuner (`tuner.ts`)

**OPRO 스타일 loop**. 사용자 vibe feedback vs. judge 점수의 **disagreement**를 학습 신호로 사용한다.

```
tune() :
  1. 최근 30개 run + evals + vibe 수집
  2. Disagreement 감지:
     - tests_pass=1 but judge.overall < 0.5
     - tests_pass=0 but judge.overall > 0.8
     - vibe=rejected but judge > 0.8
     - vibe=approved but judge < 0.4
  3. baseline correlation 측정 (judge ↔ vibe)
  4. judge에게 "이 disagreement를 설명하는 새 rubric을 제안하라" 요청
  5. 새 rubric으로 shadow-score
  6. vibe-correlation이 개선되면 accept → rubrics 테이블에 parent_ver 링크로 append
```

- 기본 **활성화** (`autoTune: true`) — judge가 로컬이라 비용 걱정 없음
- 단, disagreement 샘플이 최소 3개 이상 쌓여야 실제 tune 루프가 돈다 (`tuner.ts:242-269`). 그 전까지는 no-op
- **앵커**: `tuner.ts:12-20` (disagreement 로직), `:65` (`tune()`)

---

## L6 — Recommender (`recommend.ts`)

scorecard를 기반으로 "다음 작업에 어떤 모델을 쓸지" 제안한다.

```
recommend({ taskKind, budgetUsd, availableModels }) :
  → v_model_scorecard 조회
  → availableModels 필터링
  → budget < $5 이면 cost_per_quality 순 정렬
  → else avgOverall 순 정렬
  → top 3: { modelId, agentType, expectedScore, expectedCostUsd,
             confidence, rationale }
```

- **앵커**: `recommend.ts:31-61`

---

## L7 — HTTP API + WS Broadcast + Timeline

### HTTP Routes (`apme/http.ts:21-164`)

| Method | Route | 반환 |
|---|---|---|
| GET | `/apme` | 대시보드 HTML (inline SPA) |
| GET | `/apme/runs?limit&agent&model` | runs 목록 + evals 집계 |
| GET | `/apme/run/:id` | 단일 run 상세 (steps, turns, per-turn evals, vibe) |
| GET | `/apme/scorecard` | `v_model_scorecard` |
| GET | `/apme/categories` | `v_category_scorecard` |
| GET | `/apme/rubric/current` | 현재 general rubric |
| POST | `/apme/vibe` | `{ runId, verdict, note? }` 기록 |
| POST | `/apme/recommend` | Recommender 호출 |

### WS 브로드캐스트 (`daemon-server.ts:902-949`)

`apme.runner.onResult()` 리스너가 **평가 완료 시마다**:

```
1. apme_eval WebSocket 이벤트 브로드캐스트
   { runId, turnId?, layer, metrics, category, score, outcome }

2. BridgeTimeline 에 eval_result 엔트리 추가
   type:     'eval_result'
   icon:     ★
   raw:      ★ [category] 82% · committed
   detail:   project · prompt snippet
   color:    score 기반 (녹색 ≥70%, 앰버 ≥40%, 레드 <40%)
```

### Daemon 주기적 평가 루프 (`daemon-server.ts:951-989`)

30초마다:
1. **Enqueue** — 미평가 runs를 runner 큐에 투입
2. **Outcome compute** — 닫힌 지 10초 이상 된 run의 outcome 계산
3. **Re-classify** — `task_category IS NULL` run 재분류
4. **Orphan tagging** — 세션 프로세스 사망으로 고아가 된 run 태깅

---

## L8 — Device Rendering

모든 디바이스는 동일한 `eval_result` timeline entry type을 각자의 스타일로 렌더링한다. **에이전트별 커스텀 로직 없음** — BridgeTimeline snapshot + WS 브로드캐스트 하나로 모든 디바이스가 동기화된다.

| Device | 렌더링 |
|---|---|
| **Stream Deck** | ★ amber (score별 색상 override) |
| **Apple (SwiftUI)** | `ledAmber` LED row, `EVAL` 라벨 |
| **Android (Compose)** | `LEDAmber`, `EVAL` 태그 |
| **ESP32** | `TLToolReq` 섹션에 `@` prefix + 축약 텍스트 |
| **TUI dashboard** | terrarium timeline strip |

- **공통 경로**: `bridge/src/plugin/renderers/timeline-renderer.ts:12-20` (`evalScoreColor`)
- 점수 색상 함수 하나를 모든 렌더러가 공유

---

## 설정 — `apme/settings.ts`

```
ApmeConfig {
  enabled: boolean
  autoTune: boolean                    // 기본 false (비용)
  deterministic: {
    enabled: boolean
    timeoutSec: number
    commands: { typescript, swift, kotlin, ... }
  }
  judge: {
    backend: 'foundationModels' | 'mlx' | 'openclaw'
    model: string                         // legacy 기본 'qwen3-30b' (MLX fallback: mlx-community/Qwen3-1.7B-4bit)
    sampleRate: number                    // 0.0-1.0, 기본 1.0
    onlyWhenDisagreement: boolean         // 기본 false
    fallbackToMlx: boolean                // CLI default true for Swift-daemon-missing fallback
    endpoint: string
  }
  availableModels: string[]
}
```

로드: `~/.agentdeck/settings.json` → fallback defaults.

**비용 원칙**: judge 는 **로컬에서만** 돌린다 — App Store Swift daemon 의 Apple Intelligence, CLI 의 MLX fallback, 또는 OpenClaw Gateway. `sampleRate: 1.0`으로 전수 평가해도 비용이 0이므로 가능. 클라우드 API 백엔드는 기본 경로가 아니다.

---

## 파일 참조 인덱스

| 레이어 | 파일 | 핵심 라인 |
|---|---|---|
| L1 — Ingestion | `bridge/src/index.ts` + `bridge/src/apme/adapters/` | index.ts hook switch (`claudeHookToSpans`/`codexHookToSpans` 분기) · `wireAgentApme` 정의 (timeline 분기 + CodexTurnManager 배선) · `claude-hook.ts` / `codex-hook.ts` / `codex-turn-manager.ts` · missed-Stop watchdog `bridge/src/claude-turn-watchdog.ts` |
| L2 — Collector | `bridge/src/apme/collector.ts` | `:60` openRun · `:86` ingestHook · `:149` closeTurn · `:183` setTurnResponse · `:196` setLastClosedTurnResponse · `:239` splitRun · `:268` closeRun |
| L2 — Store | `bridge/src/apme/store.ts` | `:32-57` runs · `:68-85` turns · `:98-109` evals · `:111-119` rubrics · `:137-174` 집계 뷰 · `:178-299` DEFAULT_RUBRIC_V1 + CATEGORY_RUBRICS · `:406-439` seedDefaultRubric |
| L3 — Classifier | `bridge/src/apme/classifier.ts` | `:64` computeSignals · `:159` RULES · `:203` classify · `:239` classifyWithLlm · `:299` classifyRunSmart |
| L4 — Runner | `bridge/src/apme/runner.ts` | `:87-90` onResult · `:92` enqueue · `:102` enqueueTurn · `:172` drain · `:201` layer1 deterministic · `:235` layer2 judge · `:501` callJudge · `:508` callMlx · `:552` callOpenClaw |
| L4 — Outcome | `bridge/src/apme/outcome.ts` | `:37-43` efficiency metrics · `:47-57` composite · `:75-160` detectOutcome |
| L5 — Tuner | `bridge/src/apme/tuner.ts` | `:12-20` disagreement 감지 · `:65` tune() |
| L6 — Recommender | `bridge/src/apme/recommend.ts` | `:31-61` recommend |
| L7 — HTTP | `bridge/src/apme/http.ts` | `:39-164` 전체 라우트 |
| L7 — Daemon loop | `bridge/src/daemon-server.ts` | `:902-949` eval broadcast + timeline · `:951-989` 30s 주기 루프 |
| L8 — Render | `bridge/src/plugin/renderers/timeline-renderer.ts` | `:12-20` evalScoreColor |
| Settings | `bridge/src/apme/settings.ts` | `:44-52` ApmeConfig · `:55-70` defaults · `:80` load |

---

## 관련 문서

- [apme.md](./apme.md) — APME 개요, 이론적 배경, 활성화 방법
- [architecture.md](./architecture.md) — BridgeCore, AgentAdapter, Gateway 아키텍처
- [daemon.md](./daemon.md) — Daemon hub, 싱글턴 보장, HTTP 라우팅
