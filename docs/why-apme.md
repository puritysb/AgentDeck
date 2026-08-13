# Why APME — 감(感)에서 데이터로

> [apme.md](./apme.md)는 **무엇을 만들었나**, [apme-pipeline.md](./apme-pipeline.md)는 **어떻게 동작하나**. 이 문서는 **왜 만들었나** — 현재 내가 풀고 있는 문제, 지금까지의 한계, 그리고 APME가 어떤 구조로 그 문제를 풀어나가는지에 대한 생각을 정리한다.

---

## 1. 문제: 6개 모델을 감으로 라우팅하는 일상

현재 내 작업 루틴에 들어와 있는 모델은 최소 6개다.

```
┌───────────────────────────────────────────────────────────┐
│                     내가 쓰는 모델 라인업                  │
├──────────────────┬────────────────────────────────────────┤
│ Claude Opus 4.6  │ 메인 드라이버. 비싸고 느리지만 정확    │
│ Claude Sonnet 4.6│ Opus 리밋 소진 시 대체                  │
│ Codex (GPT-5.4)  │ 세컨드 오피니언, 대안 구현             │
│ Gemini Antigrav  │ 대용량 context, research               │
│ GLM-5.1          │ 중간 난이도 작업                        │
│ Qwen3-1.7B MLX   │ 로컬, 비용 0, 요약/분류 fallback        │
└──────────────────┴────────────────────────────────────────┘
```

이걸 내가 어떻게 배분하고 있나?

```
  Opus 리밋 다 쓸 것 같다 (감)
    │
    ▼
  "요건 Codex 한테" (감)  ─────┐
  "저건 Gemini 한테" (감)      │
  "이건 GLM 한테" (감)          ├─── 🎲 감에 의한 라우팅
  "요약은 Qwen MLX" (감)       │
                               ┘
```

이게 **효율적으로 돌아가는지 알 방법이 없다.** 두 가지 구체적인 불편함이 있다:

### 불편함 1 — 역할 경계의 불확실성

- "OpenClaw에 붙인 로컬 모델로 요약 돌리는 게 정말 괜찮은가?"
- "debugging은 Opus한테 가야 하나? Codex가 더 빠르지 않나?"
- "planning 단계는 Gemini가 맞나? 아니면 Opus의 reasoning이 필요한가?"

답이 없다. 경험 **스냅샷**(지난주에 Codex가 한 번 잘했다)은 있지만 **누적 데이터**가 없다.

### 불편함 2 — 비용 최적화의 근거 부족

- Opus는 비싸다. 어디까지 안 써도 괜찮은지 모른다.
- 로컬 MLX는 공짜지만 어느 수준까지 품질이 나오는지 모른다.
- "비용 대비 품질"이라는 값을 한 번도 계산해본 적이 없다.

결과적으로 **두려움 기반 과잉 지출**이 생긴다. 잘못되면 안 되는 작업은 무조건 Opus로 돌리고, 나중에 "정말 Opus가 필요했나?"를 돌이켜볼 수 없다.

---

## 2. 해결 방향: 개인화된 평가 시스템

범용 벤치마크(HumanEval, SWE-bench 같은)는 답이 아니다. 세 가지 이유로:

```
  범용 벤치마크                    내가 필요한 것
  ─────────────                    ─────────────
  표준 태스크                  ≠   내 실제 작업
  평균적 사용자                ≠   내 스타일/선호
  "overall 점수"               ≠   "내 코드베이스에서 debugging 잘함?"
```

내 작업에 대한 **개인화된 평가 시스템**이 필요하다. 즉:

1. **내가 실제로 시키는 태스크**에서 평가 데이터 수집
2. **카테고리별**로 모델의 강점/약점 프로파일
3. **내 기준**(품질+속도+비용)에 맞춰 추천

이게 APME가 풀려는 문제다.

---

## 3. APME의 4단계 진화

APME는 "한 번에 완성된 자동 평가 시스템"이 아니다. **단계적으로 성숙**하는 구조로 설계했다:

```
Stage 1 — 데이터 수집 (모든 세션 기록)
            │
            ▼
Stage 2 — 자동 분류 (태스크 카테고리 판별)
            │
            ▼
Stage 3 — 사람 레이블링 (대시보드 vibe check)
            │
            ▼
Stage 4 — LLM Judge 튜닝 (사람과 일치하는 자동 평가)
```

각 단계가 **이전 단계의 데이터를 연료**로 삼는다.

### Stage 1 — 데이터 수집 (모든 세션을 기록한다)

모든 에이전트 세션이 끝날 때까지 아무것도 평가하지 않는다. 일단 **기록**만 한다.

| 수집 대상 | 출처 |
|---|---|
| 프롬프트 | `UserPromptSubmit` hook / chat_start timeline |
| 응답 | Stop hook `transcript_path` JSONL / chat_response / Codex rollout JSONL |
| 툴 호출 히스토리 | `PreToolUse`/`PostToolUse` hooks |
| 파일 변경 | git diff (before/after) |
| 토큰 사용량 / 비용 | `/usage` 명령, Codex bash 로그 |
| 세션 시간 | 시작/종료 타임스탬프 |

**3가지 서로 다른 에이전트**(Claude Code / OpenClaw·OpenCode / Codex)를 **하나의 스키마**로 수렴시키는 게 관건이다. 각 에이전트의 이벤트 형태가 완전히 달라서 3개의 인제스트 경로를 만들고 `ApmeCollector` 공통 API로 수렴시켰다.

```
┌───────────────┬────────────────────────┬─────────────────────────────┐
│   에이전트     │      수집 경로          │         특이사항             │
├───────────────┼────────────────────────┼─────────────────────────────┤
│ Claude Code   │ hook HTTP POST         │ Stop 훅 유실 시              │
│               │ /hooks/:event          │ → transcript JSONL tail 이   │
│               │ + transcript JSONL     │   정본, watchdog 이 synthetic │
│               │                        │   Stop 으로 턴을 닫음         │
├───────────────┼────────────────────────┼─────────────────────────────┤
│ OpenClaw      │ adapter timeline       │ chat_start/response/end      │
│ OpenCode      │ events                 │ → collector 이벤트 매핑       │
│               │ (source:'timeline')    │                              │
├───────────────┼────────────────────────┼─────────────────────────────┤
│ Codex CLI     │ lifecycle hooks        │ codex_stop 유실 시 notify    │
│               │ + notify + rollout     │ turn-complete 가 닫고,       │
│               │ JSONL                  │ 응답은 rollout tail 로 보완   │
└───────────────┴────────────────────────┴─────────────────────────────┘
                                │
                                ▼
                      ┌──────────────────┐
                      │  ApmeCollector   │   ingestHook()
                      │  (공통 API)       │   setTurnResponse()
                      └────────┬─────────┘   closeTurn() / closeRun()
                               ▼
                      ~/.agentdeck/apme.sqlite
```

**Claude Code Stop 훅이 왜 안정성 문제인가?** v2.1.104 기준 발화율이 `11회 중 2회` 수준. 그래서 PTY 링버퍼에서 `⏺` 마커를 찾아 응답 텍스트를 직접 뽑는 **자체 파서**가 1차 경로가 되었다. 훅이 오면 더 깨끗한 텍스트로 덮어쓰는 2차 보강만 한다.

이 단계의 핵심은 **평가에 앞서 기록이 있다**는 것. 평가 로직이 나중에 바뀌더라도 원본 데이터가 있으면 재평가가 가능하다.

### Stage 2 — 자동 분류 + 카테고리별 평가 전략

수집된 run을 10가지 카테고리 중 하나로 분류한다:

```
  coding       refactoring    debugging     review
  planning     research       conversation  ops
  multi_agent  unknown
```

**왜 분류가 먼저인가?** 카테고리마다 "좋은 응답"의 정의도, **평가 방법도** 다르기 때문이다. APME의 가장 중요한 아키텍처 결정 하나가 이 지점에 있다.

#### 분류 방식 (저비용 2단)

```
  Rules (priority-ordered)
    │
    ├─ plan mode 사용? → planning
    ├─ ≤2 tools, <120s? → conversation
    ├─ web search + grep? → research
    ├─ tests + edits + bash? → debugging
    ├─ >50% Edit, 3+ files? → refactoring
    └─ ...
    │
    ▼
  unknown?
    │
    ▼
  Local MLX classifier (fallback, 공짜)
```

데몬이 30초마다 `task_category IS NULL`인 run을 재분류한다. 세션 프로세스가 일찍 kill되어 async classify가 중단된 경우를 이 루프가 복구한다.

#### 🔑 카테고리별로 평가 전략이 다르다 — 핵심 결정

`overall score 하나` 같은 단일 평가는 의미가 없다. 카테고리에 따라 **ground truth의 형태 자체가 다르기** 때문이다.

```
┌─────────────────┬──────────────────────┬──────────────────────────────┐
│   카테고리       │   Ground Truth       │   평가 타이밍 + 루브릭        │
├─────────────────┼──────────────────────┼──────────────────────────────┤
│ coding          │                      │                              │
│ refactoring     │   git diff 존재      │ ▶ run 종료 후 (run-level)    │
│ debugging       │   + 커밋/테스트       │   + 결정론 레이어 (lint/     │
│                 │                      │     build/tests)             │
│                 │                      │   + llm_judge (카테고리별)    │
├─────────────────┼──────────────────────┼──────────────────────────────┤
│ conversation    │                      │                              │
│ planning        │   응답 텍스트 자체    │ ▶ 턴마다 즉시 (turn-level)   │
│ research        │   (git 무관)         │   + llm_judge only           │
│ review          │                      │   (결정론 레이어 없음)        │
├─────────────────┼──────────────────────┼──────────────────────────────┤
│ ops             │   Bash 결과          │ ▶ run-level, general rubric  │
│ multi_agent     │   에이전트 위임 성공  │ ▶ run-level, general rubric  │
│ unknown         │   fallback           │ ▶ run-level, general rubric  │
└─────────────────┴──────────────────────┴──────────────────────────────┘
```

**왜 이렇게 나눴나?**

1. **코딩 3종 (coding/refactoring/debugging)**
   - git diff가 있어야 "무엇을 했는지"를 명확히 평가할 수 있다 → **run이 끝나야** outcome 판정
   - 결정론 레이어(lint/build/tests)가 실제로 값을 준다 — 통과/실패는 직접 측정 가능
   - LLM judge는 결정론 레이어 **위에** 품질을 덧대는 역할

2. **비코딩 4종 (conversation/planning/research/review)**
   - git diff는 의미 없다 (파일이 안 바뀜)
   - 응답 **텍스트 자체**가 결과물이므로 턴마다 평가 가능
   - 결정론 레이어는 사용 불가 (테스트할 게 없음)
   - **turn-level mid-session eval** — 세션이 끝나기를 기다릴 필요 없음. 턴 완료 직후에 즉시 judge 호출, `evals` 테이블에 `layer='turn_judge' + turn_id`로 저장
   - 대시보드에 실시간으로 턴 카드 + score + reasoning이 찍힌다

3. **나머지 (ops/multi_agent/unknown)**
   - 명확한 ground truth 형태가 없거나 혼합형이므로 general rubric + run-level로 fallback

#### 카테고리별 루브릭 7종

각 카테고리는 고유한 **평가 축(axis)**을 가진 별도 루브릭을 사용한다. `store.ts`의 `CATEGORY_RUBRICS`가 이걸 DB에 시드한다:

```
┌──────────────┬──────────────────────────────────────────────────┐
│ general      │ task_completion · code_quality · efficiency       │
│ (coding)     │   (weights: 0.50 · 0.30 · 0.20)                   │
├──────────────┼──────────────────────────────────────────────────┤
│ conversation │ accuracy · helpfulness · conciseness              │
│              │   (0.50 · 0.30 · 0.20)                            │
├──────────────┼──────────────────────────────────────────────────┤
│ planning     │ completeness · feasibility · clarity              │
│              │   (0.40 · 0.35 · 0.25)                            │
├──────────────┼──────────────────────────────────────────────────┤
│ research     │ thoroughness · relevance · synthesis              │
│              │   (0.30 · 0.40 · 0.30)                            │
├──────────────┼──────────────────────────────────────────────────┤
│ debugging    │ diagnosis · fix_quality · verification            │
│              │   (0.35 · 0.40 · 0.25)                            │
├──────────────┼──────────────────────────────────────────────────┤
│ refactoring  │ safety · improvement · scope                      │
├──────────────┼──────────────────────────────────────────────────┤
│ review       │ coverage · insight · accuracy                     │
└──────────────┴──────────────────────────────────────────────────┘
```

**이 구조의 함의**: 같은 모델이 "debugging 잘함 + conversation은 장황함"일 수 있고, 그게 **정상**이다. 카테고리별 스코어카드가 모델 선택의 근거가 된다.

### Stage 3 — Composite Score + 사람 레이블링

#### 🔑 Composite Score — 4차원 가중합

단일 점수(judge 점수 하나)는 신뢰할 수 없지만, **여러 차원의 독립 신호를 합치면** 훨씬 안정적이다. APME의 `composite_score`는 이렇게 계산된다:

```
composite = 0.40 × outcomeScore       ← "실제로 끝났는가"
          + 0.40 × judgeScore          ← "품질이 좋은가" (LLM judge)
          + 0.15 × efficiencyScore     ← "자원을 낭비하지 않았는가"
          + 0.05 × vibeScore           ← "사람이 승인했는가"
```

각 차원이 독립적이라서 한 쪽이 오류를 내도 다른 차원이 잡아준다. judge가 너무 후하게 줘도 outcome이 "abandoned"면 전체 점수는 낮아진다.

#### Outcome Taxonomy (코딩 vs 비코딩)

`outcome`은 카테고리별로 다르게 판정된다:

```
┌── 코딩 카테고리 (git diff 기반) ──┬─ score ─┐
│ committed      실제 커밋까지 감   │  1.00   │
│ ab_winner      A/B 테스트 승자    │  1.00   │
│ iterated       여러 번 시도 후    │  0.60   │
│ exploratory    변경 있으나 미커밋  │  0.50   │
│ pending        아직 진행 중       │  0.50   │
│ interrupted    사용자가 중단       │  0.30   │
│ abandoned      변경 없음          │  0.20   │
│ ab_loser       A/B 테스트 패자    │  0.10   │
└────────────────────────────────────┴─────────┘

┌── 비코딩 카테고리 ────────────────┬─ score ─┐
│ committed      응답 텍스트 캡처됨  │  1.00   │
│ (git 무관)                         │         │
└────────────────────────────────────┴─────────┘
```

비코딩은 "git commit 없이도 응답만 있으면 성공"으로 본다. Research나 planning에서 "어떤 파일도 안 바뀌었다"가 abandoned가 되면 안 되니까.

#### 사람 레이블링 (Vibe Check)

**이 단계가 현재 APME의 병목.** LLM judge를 먼저 만들지 않고 사람이 먼저 레이블링하는 이유는?

```
  "LLM judge가 정답이다"  ❌
  "사람이 레이블링한 데이터가 ground truth"  ✓
```

Judge 모델의 점수는 그 자체로는 믿을 수 없다. 같은 응답에 대해 모델마다, 프롬프트마다, 온도마다 다른 점수를 낸다. **내 취향**이 기준이 되어야 한다.

대시보드에서 run 하나하나를 훑으면서 👍 / 👎 / 중립으로 vibe feedback을 입력한다. `vibe_feedback` 테이블에 쌓이는 이 데이터가:

1. **모델별 실제 성능 프로파일** — "debugging에서 Opus가 내 기준으로 80%, Codex가 70%"
2. **Composite score의 5% 가중치** — 직접 반영
3. **Stage 4의 ground truth** — judge 튜닝의 학습 신호

#### Judge 백엔드 — "로컬 MLX가 기본"이라는 결정

```
┌────────────┬──────────────────────────────┬─────────┐
│ backend    │ 엔드포인트                    │ 역할     │
├────────────┼──────────────────────────────┼─────────┤
│ mlx        │ 127.0.0.1:8800               │ 기본     │
│ openclaw   │ 127.0.0.1:18789 (gateway)    │ 보조     │
└────────────┴──────────────────────────────┴─────────┘
```

Judge는 모든 run에 돌아간다. 클라우드 API를 쓰면 비용이 폭발하거나 사용자가 judge를 끄게 되고, 끄면 데이터가 축적 안 된다. 그래서 App Store Swift daemon 은 **Apple Intelligence Foundation Models** 를 기본으로 쓰고, CLI-only 환경은 Swift daemon proxy 가 없을 때 **MLX `Qwen3-1.7B-4bit` fallback** 또는 OpenClaw Gateway를 쓴다. 모두 로컬 경로라 전수 평가(`sampleRate: 1.0`)가 가능하다.

### Stage 4 — LLM Judge 자동 튜닝

Stage 3 데이터가 충분히 쌓이면, **사람-judge 불일치**를 learning signal로 사용할 수 있다:

```
 tests_pass=1 but judge.overall < 0.5       ← 결정론적 테스트는 통과했는데
                                              LLM judge는 나쁘다고 함

 tests_pass=0 but judge.overall > 0.8       ← 테스트 실패인데 judge는 좋다고 함

 vibe=rejected but judge > 0.8              ← 내가 거부했는데 judge는 고득점 줌

 vibe=approved but judge < 0.4              ← 내가 승인했는데 judge는 저득점 줌
```

이런 **disagreement 샘플**을 모아서 judge에게 "왜 이런 차이가 났는지 설명하고, 더 나은 루브릭을 제안하라"고 요청한다. 제안된 루브릭을 shadow mode로 기존 데이터에 적용해서 vibe와의 상관관계가 **실제로 개선**되는 경우에만 accept한다.

이게 OPRO 스타일 루프다. 결과는 **시간이 지날수록 내 판단과 일치하는 judge**가 된다.

---

## 4. 전체 그림 (실제 아키텍처)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         WHY (지금 문제)                              │
│                                                                     │
│  6개 모델 · 감 기반 라우팅 · 비용 최적화 근거 없음 · 범용 벤치마크로  │
│   ──────────────────────────────── 해결 불가 (개인화 필요)           │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        HOW (APME 구조 — 8 레이어)                    │
│                                                                     │
│  [L1] 3-path ingestion                                              │
│      Claude hook / OC timeline / Codex PTY ──┐                      │
│                                               ▼                     │
│  [L2] ApmeCollector → SQLite                                         │
│      runs · turns · steps · artifacts · evals · vibe · rubrics      │
│                         │                                           │
│          ┌──────────────┼──────────────┐                            │
│          ▼              ▼              ▼                            │
│  [L3] Classifier   [L4] Runner    [L5] Tuner                        │
│   rules+MLX         category-      disagreement                     │
│   10 categories     aware eval     → new rubric                     │
│   ┌─────────────────┴─────────────┐                                 │
│   │                               │                                 │
│   ▼                               ▼                                 │
│  run-level (coding)         turn-level (non-coding)                 │
│   det + llm_judge            llm_judge only                         │
│   git-diff outcome           response-captured outcome              │
│                         │                                           │
│                         ▼                                           │
│  [L6] Recommender — scorecard → 모델 추천                            │
│                         │                                           │
│                         ▼                                           │
│  [L7] Daemon 30s loop + HTTP /apme/* + WS apme_eval broadcast       │
│                         │                                           │
│                         ▼                                           │
│  [L8] Device rendering — ★ eval_result timeline                     │
│      Stream Deck / Apple / Android / ESP32 / TUI                    │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       WHAT (최종 산출물)                              │
│                                                                     │
│  1. 카테고리별 모델 스코어카드 (v_category_scorecard)                 │
│     "debugging 에서 Opus 0.82, Codex 0.75, GLM 0.68"                │
│                                                                     │
│  2. Composite score — 4차원 가중합                                    │
│     0.40 outcome + 0.40 judge + 0.15 efficiency + 0.05 vibe        │
│                                                                     │
│  3. 비용 효율 지표 (cost_per_quality)                                │
│     "같은 품질이라면 Codex가 Opus 대비 40% 저렴"                      │
│                                                                     │
│  4. 자동 라우팅 추천 (recommender.ts)                                 │
│     "이 태스크는 GLM → 실패 시 Opus로 escalate"                       │
│                                                                     │
│  5. 내 취향에 맞춰 진화하는 LLM judge                                 │
│     "수동 레이블링 없이도 신뢰할 수 있는 자동 평가"                     │
└─────────────────────────────────────────────────────────────────────┘
```

#### 데몬 루프가 자기 치유를 보장한다

평가는 세션 프로세스의 수명과 **분리**되어 있어야 한다. 세션이 `kill`되거나 크래시되면 진행 중이던 async 작업(classify, judge)이 날아가기 때문이다. 그래서 데몬이 30초마다 복구 루프를 돈다:

```
┌─── 30초 주기 데몬 루프 (daemon-server.ts) ───┐
│                                              │
│  1. 미평가 run 큐 enqueue                     │
│  2. 10초 이상 닫힌 run의 outcome 계산          │
│  3. task_category IS NULL 재분류              │
│  4. orphan run 태깅                          │
│                                              │
└──────────────────────────────────────────────┘
```

이 루프 덕분에 세션이 비정상 종료돼도 평가 데이터가 결국 채워진다.

#### 디바이스 렌더링이 vibe 레이블링을 촉진한다

평가 결과가 대시보드 안에서만 보이면 사용자는 그걸 **열람하지 않는다**. 그래서 `eval_result` 를 timeline entry type으로 만들어 **모든 디바이스**로 broadcast한다:

```
apme_eval WS  ──▶  BridgeTimeline  ──▶  ★ timeline entry
                                          ├─ Stream Deck (amber ★)
                                          ├─ Apple (ledAmber EVAL)
                                          ├─ Android (LEDAmber)
                                          ├─ ESP32 (@ TLToolReq)
                                          └─ TUI dashboard
```

run이 끝나면 Stream Deck + iPhone + ESP32 LED가 동시에 `★ debugging 82%`를 띄운다. 시선이 가니까 "👍/👎 누를까?"라는 생각이 든다. **데이터 수집 행동을 트리거하는 UX**가 아키텍처의 일부다.

---

## 5. 지금 어디쯤 와 있나

| 단계 | 상태 | 비고 |
|---|---|---|
| L1 3-path ingestion | ✅ 완료 | Claude(hook+PTY)/OpenClaw/OpenCode/Codex 모두 가동 |
| L2 Collector + Store | ✅ 완료 | 7개 테이블 + 3개 집계 뷰. `rubrics.version` PK 충돌 버그 2026-04-13 수정 |
| L3 Classifier | ✅ 완료 | 10 카테고리 rule + MLX fallback + 30초 재분류 루프 |
| L4 Runner (coding run-level) | ✅ 완료 | 결정론 레이어(lint/build/tests) + llm_judge 카테고리별 루브릭 |
| L4 Runner (non-coding turn-level) | ✅ 완료 | 턴 완료 직후 즉시 평가, `layer='turn_judge'` |
| L4 Judge backends | ✅ 완료 | MLX(default) / OpenClaw gateway (둘 다 로컬) |
| L5 Tuner | 🧪 구조 완료, 가동 대기 | `tuner.ts` 구현. vibe 데이터 30개 이상 쌓이면 첫 tune |
| L6 Recommender | ✅ 완료 | scorecard 기반 top-3 제안 |
| L7 HTTP + WS broadcast | ✅ 완료 | `/apme/*` 8개 라우트 + `apme_eval` WS |
| L8 Device rendering | ✅ 완료 | Stream Deck / Apple / Android / ESP32 / TUI 전부 `eval_result` 렌더링 |
| **Vibe labeling 데이터 축적** | 🔧 **병목** | 인프라는 완성. **내가 실제로 👍/👎 누르는 습관**이 남았음 |

**병목은 Stage 3다.** 기술적으로 어려운 게 아니라 **내가 실제로 레이블링을 해야 한다**는 행동 습관의 문제다. 디바이스 전반(Stream Deck, Apple, Android, ESP32)에 `★ eval_result` 렌더링을 붙인 것도 이 때문이다 — run이 끝나면 시선에 바로 들어와야 "👍/👎 누를까?"라는 생각이 든다.

---

## 6. 의도적으로 안 한 것

몇 가지는 **일부러 안 했다**. 그 이유도 기록해둘 가치가 있다:

### 6-1. Judge를 먼저 만들지 않음

LLM judge를 잘 만들어두면 사람이 레이블링할 필요 없지 않나? — 이 생각은 틀렸다. judge가 내 기준에 맞는지 **검증할 방법**이 없기 때문이다. 사람 데이터가 없으면 "judge가 잘못되고 있다"는 것조차 발견할 수 없다. 그래서 **vibe 데이터가 먼저**.

### 6-2. 범용 리더보드 배지 안 만듦

대시보드에 "이번 주 Top Model"같은 UI를 넣고 싶은 유혹이 있었지만 안 했다. 데이터가 30개도 안 쌓인 상태에서 랭킹을 보여주면 사용자(나)가 잘못된 결론을 내린다. 최소 **표본 크기**가 확보되기 전까지는 raw run 리스트만 보여준다.

### 6-3. Judge를 로컬로만 돌림

Judge는 **로컬 backend** 만 쓴다. App Store 앱은 Apple Intelligence, CLI-only fallback 은 MLX, 보조로 OpenClaw Gateway가 있지만 그것도 로컬이다. 이유:

1. **비용** — judge는 모든 run에 돌아가야 한다. 클라우드 API면 즉시 비용 문제
2. **신뢰 loop** — 비용이 두려우면 judge를 끄게 되고, 끄면 데이터가 축적 안 된다
3. **죄책감 없는 전수 평가** — `sampleRate: 1.0`이 기본. 로컬이니까 가능

성능 trade-off(로컬 < 프론티어 모델)는 **Stage 4의 auto-tune이 채운다**는 게 가설이다. 싼 judge + 튜닝 루프 > 비싼 judge + 정적 루브릭.

### 6-4. "코딩만" 평가하지 않음

APME 초기 설계는 `git diff` 기반 coding 평가가 중심이었다. 그런데 내가 실제로 모델을 가장 자주 쓰는 건 **코딩이 아니라 다른 것**이었다:

- "이 에러 로그 설명해줘" (conversation)
- "이 라이브러리 뭐 쓰는지 조사해줘" (research)
- "이걸 어떻게 리팩토링할까" (planning)

이런 non-coding 카테고리가 평가 안 되면 APME는 내 실제 사용 패턴의 **절반도 못 담는다**. 그래서 category rubrics와 **turn-level mid-session eval**을 만든 것이다 (코딩은 run 종료 후, 나머지는 턴마다).

---

## 7. 성공의 정의

APME가 **성공했다고 말할 수 있는 조건**은 무엇일까?

```
6개월 후 어느 날, 새 태스크를 시작할 때:

  "이건 debugging이니까 Codex"  ← 감이 아니라
  "지난 50개 debugging run에서 Codex가 Opus 대비 품질 95%,
   비용 40% — 이 태스크도 Codex로 가자"  ← 데이터 기반
```

혹은:

```
  "이 작업은 중요하니까 Opus"  ← 감이 아니라
  "이 카테고리는 내 vibe 기준으로 모델 간 갭이 크다
   → Opus, 반대로 카테고리는 갭이 작음 → MLX"  ← 데이터 기반
```

이렇게 **판단의 근거가 SQLite 안에** 있게 되는 것이 목적이다.

---

## 관련 문서

- [apme.md](./apme.md) — APME 개요, 이론적 배경, 활성화 방법
- [apme-pipeline.md](./apme-pipeline.md) — 8-layer 파이프라인 구현 상세
- [architecture.md](./architecture.md) — AgentDeck 전체 아키텍처
