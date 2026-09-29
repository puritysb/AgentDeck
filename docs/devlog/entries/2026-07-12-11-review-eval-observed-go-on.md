# 2026-07-12 — REVIEW=독립 eval로 재설계 · observed GO ON 제거 · 에이전트별 버튼 매트릭스 정리

### 배경 (스티어링 재점검)
사용자 재점검 결론: ① observed processing의 GO ON 선제 큐잉은 실존하지 않는 시나리오(턴은 의도적으로 끝나지 조기 종료하지 않음) — 제거. ② COMMIT="작업 완료 후"=턴엔드 큐 의미 그대로 유지. ③ REVIEW는 에이전트에게 보내는 프롬프트가 아니라 **독립 모델이 최종 결과물의 리스크를 평가하는 eval**로 재설계 — 에이전트 제어가 불필요해져 managed/observed 전 타입+**codex observed(유일 가용 액션)**까지 커버.

### REVIEW = `review_run` (신규 PluginCommand)
- **Node 데몬** (`bridge/src/review-runner.ts`): 세션 cwd의 git diff(60KB 캡)+untracked 수집 → APME judge 스택 재사용(`callJudgeWithMeta`, 로컬 우선/API opt-in) → 리스크 JSON(strict) → self-contained aquarium-tide HTML 리포트를 `<dataDir>/reviews/`에 생성 후 **브라우저 오픈**(앱 없는 CLI 티어의 팝업). cwd 해석: observed 행 cwd → APME run projectPath 폴백.
- **Swift 데몬** (`ReviewRunner.swift`): 샌드박스는 git 실행·cwd 읽기 불가 → **입력=자기 타임라인 트래젝토리**(프롬프트/툴/응답), judge=`ApmeJudgeFoundationModels`(온디바이스). 결과=**비모달 NSPanel 네이티브 팝업**(modal NSAlert 금지 — MainActor 데몬 정지) + "Open HTML Report" 버튼(컨테이너 파일+NSWorkspace, 서브프로세스 없음). `review_run` 인터셉트는 gateway 소비 블록 앞.
- 공통: `review_status`/`review_result` WS 이벤트 + `SessionInfo.reviewStatus/reviewRisk/reviewFindings` 배지(30분 TTL) → REVIEW 타일이 REVIEWING/`risk low · 2` 표시. 실행 중 중복 트리거 무시.

### 버튼 매트릭스 (d200h-layout + SD plugin 공통)
| | managed | observed Claude | observed OpenCode | observed Codex |
|---|---|---|---|---|
| idle | GO ON·REVIEW·COMMIT·CLEAR | REVIEW+OBSERVED 타일 | GO ON·COMMIT(inject now)+REVIEW | REVIEW+OBSERVED |
| processing | RUNNING·모델·REVIEW | STOP·COMMIT(at turn end)·REVIEW | STOP·REVIEW | REVIEW |
- observed processing GO ON 제거, OpenCode mid-run inject 제거(실행 중 끼어들기 배제). REVIEW는 SD에서 `localAction:'review_run'` 프리셋(배지 포함), D200H에서 `reviewTile()`.

### 검증
- vitest 97/1745 전부 통과(d200h-observed 매트릭스 테스트 재작성), `xcodebuild AgentDeck_macOS` BUILD SUCCEEDED, generate-protocol 재생성(ReviewRunCommand/ReviewStatus·ResultEvent), design lint 905(신규 위반 0).
- 미실시: judge 실호출 E2E(FoundationModels/MLX 실행 시간 소요) — 실기 REVIEW 버튼 1회 눌러 패널/브라우저 확인 필요.
