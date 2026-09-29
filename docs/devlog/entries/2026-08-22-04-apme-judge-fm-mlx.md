# 2026-08-22 — APME judge 기본값을 FM 에서 로컬 MLX 로 뒤집다: 창은 실측이고, 바닥은 남긴다

### 남겨 뒀던 결정을 닫는다

바로 앞 항목이 "APME 기본 judge 백엔드를 FM 에서 바꿀지는 별도 결정으로 남긴다"로
끝났다. 근거가 두 개 더 생겨 닫았다.

**첫째, 폴백은 절반만 있었다.** Node 는 FM 실패 시 MLX 로 재시도하지만
(`fallbackToMlx`), Swift `ApmeRunner.callJudge` 에는 폴백이 아예 없다 — 주석이
"사용자가 고른 백엔드가 죽었으면 눈에 보이게 skip 한다"고 정책을 명시하고 있고,
그 정책이 **기본값에도** 적용되고 있었다. 즉 macOS 앱에서는 FM 이 유일한 판정자였다.

**둘째, FM 의 컨텍스트를 실측했다.** 4,096 은 선언값이었는데, 넘겨 보면
`exceededContextWindowSize` 로 즉시 거부하면서 **자기가 센 토큰 수를 알려준다**.
그 오류를 토크나이저로 되썼다(2026-08-22): 영문 4.68자/토큰, 한국어 1.64자/토큰 —
영문 약 19,200자 · 한국어 약 6,700자에서 벽. 이 계측기로 이 기계의 실제
`task_rollup` 판정 프롬프트 1,294건을 재구성해 재보니 p50 1,219 · p90 2,968 ·
p99 7,371 · 최대 12,336 토큰이고 **4.2% 가 창을 넘는다**. 넘으면 판정이 실패하고,
안 넘으면 방향이 틀린 점수가 폴백 없이 DB 에 적힌다 — 후자가 더 나쁘다.

### 조치

`judge.backend` 기본값 `foundationModels` → **`mlx`**, 새 플래그
`fallbackToFoundationModels` 로 FM 을 바닥에 남겼다(Node `settings.ts`+`runner.ts`,
Swift `ApmeSettings`+`ApmeRunner`+`ApmeClassifier`, `config/default-settings.json`,
[docs/apme.md](docs/apme.md)). **기본값 뒤집기는 기능 삭제**라는 규칙이 여기서
그대로 적용된다 — MLX 서버가 없는 기계(App Store 단독 설치가 정확히 그 경우)는
예전과 똑같이 온디바이스로 평가된다. 사라지는 기능이 없어야 뒤집을 수 있다.

**폴백은 기본값에만 붙는다.** 사용자가 `judge.backend` 를 직접 적었으면 그 플래그를
끈다 — Swift 가 이미 명시하던 cost-sensitive-defaults 규칙(명시한 백엔드가 죽어
있으면 조용한 강등이 아니라 보이는 skip)을 깨지 않기 위해서다. 알 수 없는 백엔드
문자열은 "선택"이 아니므로 기본 체인과 폴백이 함께 돌아온다.

**Swift 는 판정 행 귀속을 고쳐야 했다.** `judgeModelLabel` 이 설정값에서 계산되던
계산 프로퍼티라, 폴백이 생기는 순간 실행되지 않은 다리에 행이 붙는다. Node 의
`JudgeResult` 처럼 `callJudge` 가 `(text, label)` 을 함께 돌려주게 바꿨다.

### 딸려 나온 것 — basic 티어가 자기 창을 26% 넘기고 있었다

REVIEW 는 백엔드로 티어를 고르는데(`foundationModels` → basic), 그 basic 티어의
자체 상한 조합(diff 12KB + 활동 4,000자)으로 프롬프트를 만들어 재보니 **5,161
토큰**이었다. FM 전용으로 만든 티어가 FM 창을 넘긴다. 활동 기록이 사용자 프롬프트,
즉 한국어라 토큰이 가장 비싼 입력인데 상한은 문자 수로 잡혀 있었던 탓이다.
실측 계수 기준으로 줄였다: diff 12KB → 5KB, 활동 4,000자 → 1,200자, Swift 궤적
6,000자 → 3,000자(≈2,900 토큰, 답변 여유 ~1,200).

그리고 REVIEW 는 이제 **실제로 답할 백엔드를 먼저 확정한다**
(`resolveJudgeBackend` / `ReviewRunner.resolveBackend`). 이게 없으면 기본값 뒤집기가
두 방향으로 기능을 없앤다 — MLX 없는 기계에서 "판정자 없음" 안내로 끝나거나, 더
나쁘게는 advanced 티어로 잡은 60KB diff 를 온디바이스 모델에 넘긴다.

### 계측 쪽(model-eval, 교차 저장소)

장문 판정 시나리오 2종 신설 — J05(3,413 토큰, FM 창 바로 아래)·J06(13,423 토큰,
FM 자동 제외). 6모델 × 3반복: DeepSeek V4 Pro·Qwen3.8-27B(dense) 1.000,
GLM-5.3 0.979, GLM-5.2 0.925, Qwen3.6-35B-A3B(MoE) 0.875(J06 3회 전부 JSON
미완결 = 판정 행 유실), Apple FM 0.550(J05 만; 전면 되돌린 태스크에
completion 1.0 + "잔상을 고쳤다" 요약). <https://eval.foundby.kr> 재배포.

### 남긴 것

`callFoundationModels` 의 HTTP 실패 경로는 **내용 오류(컨텍스트 초과·언어 거부)도
가용성 캐시에 "unavailable" 로 적는다.** 한 번의 과대 프롬프트가 TTL 동안 FM 을
죽은 것으로 표시한다 — 기본값이 바뀌어 FM 이 바닥 티어가 된 지금은 피해가 작지만,
값이 두 가지를 뜻하는 전형적인 형태라 다음에 손댈 때 분리한다.

---
