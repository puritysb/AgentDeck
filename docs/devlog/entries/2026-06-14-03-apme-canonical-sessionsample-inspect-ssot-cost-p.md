# 2026-06-14 — APME 재구축: canonical SessionSample (Inspect 스타일) SSOT + cost/Pareto + 타임라인 projection

### 문제
타임라인과 APME 평가가 **두 개의 분리된 파편화 파이프라인**이었다. 어댑터가 chat_start/response/end·tool_request/resolved 를 직접 emit(중복·race·경계 없음), 디스플레이타임 `groupConsecutive` 로만 묶임. OpenClaw `session.tool`/`session.message` 는 default case 에서 **silent drop**(`openclaw.ts:1093`) → 대부분 도구 호출이 아예 안 보임. 평가 단위(`task`)는 untyped `steps` + `tool_calls:count` 로 trajectory 손실. 비용/모델 비교는 스키마에만 있고 미활용.

### 해결
Inspect AI 의 `EvalLog→Sample→Event→Scorer` 모델을 네이티브(TS+Swift, Python/subprocess 無)로 차용. **`SessionSample`** = 경계 있는 단위 + 타입 trajectory(user/assistant/model/tool/state/info) 를 도입, 타임라인·평가 **둘 다 이것의 projection**.
- **shared**: `sample.ts`(SessionSample + TrajectoryEvent), `pricing.ts`(override 가능 단가표, local=$0), `trajectory` eval layer.
- **bridge**: collector 가 `sample_events` 에 dual-write(UNIQUE index 저장시점 dedup) + cumulative-usage delta 로 per-task 비용 pricing; runner 가 `getSample()` 로 도구 trajectory 를 judge 프롬프트에 + `scorers/`(trajectory_quality·tool_efficiency); `pareto.ts` frontier + recommender 재배선; `/apme/pareto`·`/apme/samples` 라우트; OpenClaw `session.tool`/`session.message` 캡처 복구.
- **Phase 6 타임라인 컷오버 (flag-gated, default OFF)**: `AGENTDECK_TIMELINE_PROJECTION=1` 시 타임라인이 SessionSample projection 으로 전환 — 로컬 chat/tool 행 suppress, projected/relayed/task 행은 bypass. `BridgeTimelineStore.setSuppressLocalChatTool` + `add(entry,{bypassSuppression})`, `DaemonTimelineStore` 미러.
- **Swift 데몬 미러**: 스키마+sample DAO, collector dual-write+pricing(`ApmePricing.swift`), scorers(`ApmeScorers.swift`), Pareto recommender, HTTP 라우트, projection. App Store 타깃 빌드 clean, 신규 subprocess 문자열 0.
- 검증: vitest **1360 통과**, `xcodebuild AgentDeck_macOS` SUCCEEDED. 데몬 재시작으로 라이브 반영 + 신규 라우트 실측 확인. 커밋 `e83953f5`.

### 핵심 설계 결정
- **하나의 normalizer(collector) + 두 projection(타임라인·평가)** 으로 "two pipelines" 버그군 제거 — 디스플레이타임 grouping·8s race dedup·OpenClaw drop 이 부수적으로 해결됨.
- 기존 `task` 행 = SessionSample 헤더로 재사용(rename 없음). `steps` 는 raw archive 로 유지.
- 컷오버는 **env 플래그 default OFF** — 배포는 타임라인 무변경(안전), 사용자가 1개 표면에서 렌더 검증 후 전역 flip. 코드 변경 없이 env 빼면 즉시 원복.
- Node/Swift 데몬은 **alternative(동시 아님)** 라 sample dedup_key 는 raw composite 로 충분(cross-daemon dedup 불필요).
- pricing 달러값은 best-effort public 단가 + **런타임 override 가능**(`setPricingOverrides`) — 코드 수정 없이 정정. claude-api skill 의 단가가 redacted 라 임의값 하드코딩 회피.
