# 2026-07-13 — REVIEW mid-turn 게이팅: 진행중 턴에서 데크 REVIEW 비활성 + Swift 데몬 가드

### 문제
사용자 지적: Swift 데몬에서 Stream Deck/D200H가 **에이전트 작업 진행중(processing)에도 REVIEW를 누를 수 있는** 흐름이 어색함. 조사 결과 세 표면(d200h-layout processing 분기, SD 플러그인 managed/observed processing 분기) 모두 활성 REVIEW 타일을 노출했고, 근거 주석 "judges the current delta"는 **Node 데몬(git working-tree diff)에만 맞는 가정**. Swift 데몬 `handleReviewRun`은 상태 가드 없이 타임라인 trajectory를 judge에 넘기는데, judge 프롬프트가 "incomplete work/검증 생략"을 리스크로 잡도록 지시하므로 진행중 턴(응답 없는 USER+TOOL)은 구조적으로 오탐 리스크 보고 + 작업 중 결과 패널 팝업.

### 해결
- **데크 게이팅(2표면)**: processing 중 REVIEW → 비활성 배지로 강등. 판정중이면 REVIEWING 스피너, 직전 verdict 있으면 inert `risk … · N` 배지, 없으면 타일 생략. shared `reviewBadgeTile()` + SD `reviewBadgeSlotConfig()`. idle/턴 종료 후엔 기존대로 pressable(verdict 배지 재실행 포함).
- **Swift 데몬 방어 가드**: 세션 상태 `processing`/`awaiting*`이면 review_run 거절 + `review_status:error`("run REVIEW after the turn completes") 브로드캐스트. 직전 verdict 배지는 보존(lastReviewBySession 안 건드림). 구형/서드파티 클라이언트 커버.
- Node 데몬은 무변경 — diff 기반 mid-turn 리뷰 의미는 유지되나 데크에서 더 이상 트리거 안 됨.

### 핵심 설계 결정
REVIEW = "완료된 작업의 독립 평가"로 의미 통일. 데몬별 리뷰 입력(Node diff vs Swift trajectory)이 달라도 데크 UX는 동일하게 턴 완결 후에만 제공. 동종 어색함 스윕 결과 나머지는 건강(observed awaiting w/o requestId→"answer in terminal" 비활성, Codex notify-only 무버튼, STOP steerable-only, COMMIT "at turn end" 명시).

### 검증
vitest 1767 전체 통과(d200h 테스트 신규 2건: processing 중 review_run 부재 + inert 배지), `pnpm build` green, macOS xcodebuild BUILD SUCCEEDED. 실기 시각 확인(D200H/SD+ processing 중 배지 렌더)은 후속.
