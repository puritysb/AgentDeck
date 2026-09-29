# 2026-08-22 — 로컬 LLM 워크로드가 model-eval 에 처음 계측되다: Ollama 폴백 제거 + APME missed 축 명확화

### 배경

`../foundby-eval`(생성기 `OpenClaw/model-eval`)이 GLM·Qwen 세대 교체를 38종 시나리오로
재던 동안, AgentDeck 이 같은 로컬 모델 플릿에게 시키는 일 — 타임라인 한 줄 요약,
APME 세션 판정, REVIEW diff 리스크 평가 — 은 어느 시나리오도 덮지 않았다.
게다가 요약기의 Ollama 폴백 티어는 `qwen2.5:7b` 를 하드코딩하고 있었다.
평가 플릿보다 두 세대 전 모델이고, Settings 피커는 이 티어를 선택지로 보여주지도 않았다
(auto 설명문도 "FM → MLX → heuristic"이라고 적혀 있었다).

### 조치 (AgentDeck)

- **요약기 Ollama 티어 제거** — Node(`timeline-summarizer.ts`)·Swift(`TimelineSummarizer.swift`)
  미러 동시. MLX 티어는 서버가 실제로 서빙하는 모델을 프로브하므로 같은 방식으로 낡을 수 없다.
  체인 테스트는 "11434 로 다이얼하지 않는다"를 못박는 부정 케이스로 교체. 과거 타임라인 행의
  `summaryKind:"ollama"` 라벨 매핑(Swift/Kotlin)은 렌더용이므로 유지. judge-detect 의 Ollama
  후보는 동적 프로브라 유지.
- **APME general 루브릭 `missed` 축 명확화** — model-eval 신규 시나리오 J02 스모크에서
  프런티어급 판정자(GLM-5.3)가 스타일 nit 를 `missed` 에 넣는 걸 확인했다. 스코어카드는
  `missed` 를 "빠뜨린 작업"으로 렌더하므로 완수한 태스크가 미완으로 읽힌다. 프롬프트에
  "missed 는 요청 중 안 한 것만, nit 는 reasoning 으로" 한 줄을 추가하고, **시드 마이그레이션**
  (Node `seedDefaultRubric` + Swift `upgradeLegacyGeneralRubric`)으로 기존 설치본의
  legacy 원문과 byte-identical 할 때만 새 버전을 append (사용자가 고친 루브릭은 불가침,
  parent_ver 로 이력 보존, 양 데몬 공존 시 한 번만). 게이트:
  `apme-rubric-migration.test.ts`.

### 조치 (model-eval 쪽, 교차 저장소)

시나리오 5종 신설 — `judging` 분류 + `judge-fidelity@1` 루브릭(계약/보정/근거/절제):
J01·J02(APME 판정, 명백한 실패/성공 런 쌍), J03·J04(REVIEW diff, 심은 결함/무결함 함정),
I05(타임라인 한 줄 요약, 되돌린-접근 함정). 프롬프트는 AgentDeck 이 실제로 보내는
계약을 그대로 복사했다. `agentdeck-judge` 프로파일 신설. 계측기 검증에서 J04 v1 의
"무결함" diff 가 코드 없는 기능 주장(CHANGELOG)을 담아 함정이 뒤집혔던 것을 GLM-5.3 이
정당하게 지적해 v2 로 교정 — fixture 를 계측하라는 규칙이 여기서도 맞았다.

### 측정 결과 (full-2026-08-20 에 75회 append, 5모델 × 5시나리오 × 3반복)

클라우드 3종(GLM-5.2/5.3, DeepSeek V4 Pro)과 **dense Qwen3.8-27B 는 전회통과 15/15 ·
가중 1.000**. **현행 로컬 모델 Qwen3.6-35B-A3B(MoE) 만 9/15 · 0.860** 으로 무너졌고,
실패가 정확히 AgentDeck 의 아픈 지점 둘이다: J02(성공 런 판정)에서 3회 전부 JSON 을
닫지 못하고 잘렸고(= `parseJudgeJson` null → 판정 행 유실), J04(무결함 diff)에서 3회
전부 "오타 수정" 을 finding 으로 채워 넣었다(= REVIEW 거짓 경보). 8800 서버 그대로의
서빙 설정으로 잰 값이라 생태적으로 유효하다. 실무 함의: **APME judge 를 로컬로 쓰려면
dense Qwen3.8(8801, `enable_thinking:false`) 쪽에 앉혀야 한다** — MoE 는 요약(I05 만점)엔
충분하지만 판정 계약엔 부족하다.

### 추가 라운드 — Apple Foundation Models 를 계측에 넣었다 (같은 날)

model-eval 러너가 `openclaw infer` 경유라 FM 은 계측 밖이었는데, AgentDeck 의
`fm-helper`(JSON-lines stdin/stdout)를 model-eval 이 직접 부르는 러너 분기
(`runner: "fm-helper"`, `run_v2.py::_run_fm_helper`)로 등재했다. 두 함정: 헬퍼는
generate 를 별도 작업 체인에 넘기므로 **stdin 을 응답 한 줄 읽을 때까지 열어 둬야**
하고(`communicate()` 는 응답 전에 프로세스를 죽인다), fm 출력은 이미 모델 본문이라
openclaw JSON 봉투 해체(`_extract`)를 타면 판정 JSON 이 재직렬화된다.

39종 × 3반복 실측(전회통과 15/96 · 루브릭 0.580): **기본 judge 백엔드인 FM 은
판정자로 부적격이다.** J01 실패 런에 후한 점수, J02 성공 런에 유령 missed(diff 의
테스트 헌크를 못 봄), J04 무결함 diff 에 결함 발명, J03 은
`unsupportedLanguageOrLocale` 로 3/3 실행 거부 — diff·압축요약·번역류 입력 15회가
같은 언어 감지에 걸렸다(지시문을 바꿔도 동일 — 프롬프트 내용이 원인). 반면 요약(I05)은
0.93(끝 마침표 하나) — **요약기 1순위 티어로는 타당, 판정 기본값으로는 재고 대상**.
`agentdeck-judge` 프로파일에서는 품질 게이트(0.58 < 0.8)로 자동 제외된다.

### 남긴 것

REVIEW 판정 가이드의 Ollama 예시 모델은 `qwen3-coder:30b` 로 갱신. 장문 입력
열화(judge 프롬프트 10K+ 토큰 체제) 시나리오는 후속 — 현 시나리오는 16K 로컬 컨텍스트를
건드리지 않는 길이다. APME 기본 judge 백엔드를 FM 에서 바꿀지는 별도 결정으로 남긴다 —
폴백 체인(FM→MLX)이 있어 즉시 사고는 아니지만, FM 이 성공적으로 응답한 판정일수록
(파싱은 되는데 방향이 틀린 점수) 폴백 없이 DB 에 적힌다는 점이 나쁘다.

### 문제

플랜 랭킹을 고친 직후인데도 Codex 게이지가 다시 틀렸다. 데몬 와이어는 5h 0% / 7d 0%,
그런데 계정 실제 사용량은 7d **13%**. 사용자가 먼저 짚었다 — "GPT-5.3-Codex-Spark
한도가 보이는 것 같다".

맞았다. 데몬이 내보내던 블록은 `limit_id: "codex_bengalfox"`,
`limit_name: "GPT-5.3-Codex-Spark"` — **모델 하나짜리 한도**였다.

### 측정

롤아웃 823개 전수 조사 결과 계열은 셋뿐이고 판별자가 정확했다:

| `limit_id` | `limit_name` | 줄 수 | 성격 |
|---|---|---|---|
| `codex` | `null` | 37,985 | 계정 전체 |
| `premium` | `null` | 66 | 계정 전체(크레딧 요금제) |
| `codex_bengalfox` | `"GPT-5.3-Codex-Spark"` | 915 | 모델 스코프 |

결정적 관찰은 **한 세션 안에서 계열이 시간에 따라 번갈아 나온다**는 것이다. 같은 파일에서
`codex`(11:36Z, 66%) → `codex_bengalfox`(16:36Z) → `codex`(20:15Z, 4%) →
`codex_bengalfox`(22:25Z~03:28Z). 모델이 `gpt-5.6-sol`인 세션인데도 최근 5시간은 Spark
계열만 기록했다. 즉 "가장 최신 줄"과 "계정 한도"는 서로 다른 축인데, 리더는 `limit_id`를
저장만 하고 판단에 쓰지 않았고 `limit_name`은 Node·Swift 어디서도 파싱조차 안 했다.

### 해결

`isModelScopedCodexLimit(limitName)` — **이름이 붙어 있으면 모델 스코프**. 양쪽 데몬의
패시브 파서가 그런 줄을 만나면 **건너뛰고 계속 스캔한다**(파일을 버리지 않는다 — 같은
tail 뒤쪽에 계정 줄이 있다). live 리더는 top-level이 스코프면 `rateLimitsByLimitId`에서
이름 없는 계열로 폴백한다.

### 핵심 설계 결정

- **이건 신선도도 플랜도 아닌 세 번째 축이다.** 스코프 스냅샷은 *최신이고* 플랜도 맞다 —
  그냥 다른 양(quantity)일 뿐이다. 그래서 기존 두 축 중 무엇도 이걸 잡을 수 없고,
  "최신 줄이 이긴다"가 조용히 측정 대상을 바꿔치기한다.
- **폴라리티는 이름 없는 것의 allow-list.** `limit_id !== 'codex_bengalfox'` 같은
  deny-list였다면 새 모델 계열이 계정 값으로 둔갑한다(틀린 값). allow-list면 최악이
  "안 보임"(열화)이다. CLAUDE.md 미지값 규칙 그대로다. `premium`이 이름 없는 계정
  계열이라는 사실이 id 기반 필터를 즉시 배제해 준다 — 크레딧 게이지가 함께 사라졌을 것이다.
- **스코프만 있으면 아무것도 보고하지 않는다.** 0%를 계정 값으로 그리는 것보다 낫다.
  데몬은 live 질의로 메우고(계정 계열), 세션 브리지는 게이지를 감춘다. 잘못된 라벨의
  숫자는 없는 숫자보다 나쁘다.
- **fixture가 두 축을 섞고 있었다.** 직전 커밋의 plan 테스트 fixture는 "그 파일의 가장
  최신 rate_limits 줄"을 그대로 복사한 것이었는데, 그게 바로 `codex_bengalfox` 줄이었다.
  진짜 데이터였지만 plan 축과 계열 축을 conflate했고, 계열 필터가 들어오자 즉시 깨졌다.
  실제 줄을 쓰는 것만으로는 부족하고 **테스트하려는 축을 격리한 줄**이어야 한다. 지금
  plan 테스트는 계정 계열 실제 줄에 `timestamp` 한 필드만 옮겨 쓰며, 무엇을 왜 바꿨는지
  주석에 적었다.

### 검증

- 실제 트리 대상 격리 실행: 수정 전 `codex_bengalfox` 0% → 수정 후 `codex` 2%(패시브),
  live 도착 후 **13%**(정확)
- vitest 3,277 · macOS XCTest ProtocolTests 74 · 생성 미러 drift in sync

---
