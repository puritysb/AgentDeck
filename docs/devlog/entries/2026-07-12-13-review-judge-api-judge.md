# 2026-07-12 — REVIEW judge 프리플라이트/가이던스 · 옵트인 API judge · 수동리뷰 히스토리 · 대시보드 미평가 설명

### 배경
REVIEW=독립 eval 재설계 후속. 사용자 지적: judge 머신이 없거나 지정 안 된 경우 정확히 안내하고, 현실적 최소 수준(로컬 8B+)을 감안해 미사용 상황도 고려하며, 외부 API 연동이 필요하면 그쪽으로 유도할 것. 또 수동 리뷰와 APME 자동 리뷰는 같은 목적이니 대시보드에서 수동 실행분을 구분 플래그로 볼 수 있게 하고, 대시보드 데이터 표시 의미성도 점검할 것.

### judge 프리플라이트 + 가이던스 플로우
REVIEW 버튼을 눌렀을 때 사용가능 judge가 없으면 dead-end 에러 대신 **셋업 가이드**를 띄운다. Node=self-contained HTML을 `<dataDir>/reviews/`에 쓰고 브라우저 오픈(앱 없는 CLI 티어의 팝업), Swift=네이티브 NSPanel(`ReviewGuidancePanelView`). 양쪽 모두 리뷰 품질 순으로 백엔드 랭킹: **① Anthropic API(최상) → ② OpenClaw 게이트웨이 → ③ 로컬 MLX(8B급 최소, 30B급 권장) → ④ Apple Intelligence(온디바이스, 기본 스크리닝만)**. "REVIEW 안 써도 무방(백그라운드 실행 없음)"을 명시해 미사용을 정식 선택지로 안내. 리포트 푸터에 정직한 judge-tier 캐비앗(`judgeTierNote`).

### 옵트인 Anthropic API judge (Node)
`callApi()`를 `@anthropic-ai/sdk`로 실제 구현(이전엔 항상 throw하는 스텁 → settings 로더가 "mlx"로 silent 다운그레이드). **엄격 옵트인**(cost-sensitive defaults 정책): 자동 선택 경로 없음, 크레덴셜(`apme.judge.apiKey`/`ANTHROPIC_API_KEY`/`ant auth login`) 없으면 프로브가 셋업 가이드와 함께 `unavailable`. settings.ts의 api→mlx 리라이트 제거. 프로브는 무료 Models 엔드포인트로 모델 id 검증(토큰 소비 0).

### 수동 리뷰 히스토리
REVIEW 완료 시 `manual_review` 레이어 eval(metric=risk, score=리스크가중치)을 자동 파이프라인과 **같은 APME 스토어**에 세션 활성 태스크로 기록. 신규 `ApmeEvalLayer='manual_review'`(+ `ApmeEvalRow` 유니온, 프로토콜 코드젠 재생성). 대시보드에 "Manual Reviews (hand-run)" 섹션(리스크/발견수/judge 모델), 레이어 필터로 자동 eval 섹션 오염 없음. Swift는 `ApmeCollector.activeRunAndTask`로 동일 기록.

### 대시보드 데이터 의미성
미평가 완료 run(composite/judge eval 전무 — judge 미설정 시 흔함)이 헤더만 덜렁 뜨던 문제 → "Not evaluated — <이유>" 설명 + apme.judge 안내(REVIEW 가이드와 동일 맥락) + "trajectory/cost/outcome는 여전히 기록됨" 명시. 나머지 표면(scorecard/categories/recommend 빈 상태, active-session pending)은 이미 graceful — 회귀 방지 테스트로 잠금.

### 검증
- vitest 100파일 1758/1758(신규: review-runner 렌더/가이던스/tier, apme-manual-review 라운드트립, apme-dashboard-html 어포던스; apme-settings/apme-judge-probe는 구현된-API 계약으로 갱신).
- `xcodebuild AgentDeck_macOS` BUILD SUCCEEDED. design lint 905(불변). generate-protocol 재생성.
- 커밋 `f5831db5`+`41b04749` (origin/master).
- 미실시: judge 실호출 E2E(로컬 MLX/FM/API 실행 필요) — 실기 REVIEW 1회로 확인 권장.
