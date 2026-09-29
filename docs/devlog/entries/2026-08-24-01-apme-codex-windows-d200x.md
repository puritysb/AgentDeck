# 2026-08-24 — 공개 이슈 정리: APME 턴 귀속·비용 출처·응답 소유권, Codex Windows 보강, D200X 키패드

### 해결한 결함 (#265–#268)

- OpenClaw 한 task 안에서 모델/provider가 바뀌어도 run의 마지막 값으로 모든 scorecard가
  덮이던 문제를 `turns.model_id` / `turns.provider` 귀속으로 바꿨다. task 집계는 여러
  identity를 만나면 `mixed`; run 열은 구 API 호환용 최신값일 뿐 순위의 근거가 아니다.
- provider 정규화의 정본을 `shared/src/model-provider.ts`에 두고 local/MLX/Ollama/
  LM Studio를 포함한 Swift/Kotlin 미러를 재생성했다.
- 미가격 remote의 보고값 `$0`과 실제 무료 local `$0`을 `cost_known`으로 분리했다.
  unknown은 SQL/API `NULL`, budget 추천 제외; 가격표 또는 known-local인 0만 무료로
  정렬한다. 양수 비용은 구 caller도 안전하게 known으로 승격한다.
- `chat.final`과 `session.message` assistant 투영본의 도착 순서가 바뀌어도
  `chat_final > direct > session_message_projection`을 유지한다. 한 turn에는 안정적인
  assistant event 한 칸만 쓰므로 8K 투영본이 전체 응답을 덮거나 중복 행을 만들지 않는다.
- Node와 Swift daemon의 SQLite/view/migration/recommender/API 의미론을 함께 맞췄다.

### 안전하게 전진한 이슈 (#143, #174)

- Windows Codex hook-only 세션은 session id로 rollout을 찾아 `session_meta.originator`가
  `Codex Desktop`이면 ChatGPT/Codex App 관측 행으로 승격한다. subagent rollout은
  억제하며, macOS/Linux의 pid/fd observer와 중복 스캔하지 않는다. 단, Windows ChatGPT가
  실제로 `%USERPROFILE%\.codex\config.toml` hook을 발행하는지는 실기 검증이 남았다.
- Ulanzi 공식 SDK의 `Devices` 계약에 따라 동일한 14 LCD-key AgentDeck action을 D200X에도
  노출했다. 매니페스트 회귀 테스트가 D200H+D200X와 `Keypad`-only 경계를 고정한다.
  D200X의 세 encoder는 별도 action/UX와 실기 검증이 필요하므로 지원을 주장하지 않는다.

### 검증

- Node 전체: 226 files / 3,514 tests (최초 구 계약 4건을 발견해 의미론을 갱신한 뒤 재실행)
- Apple: `AgentDeck_macOS` Debug build 성공, 선택 APME 55 tests / 0 failures
- Ulanzi: typecheck, manifest/localization/device tests, self-contained Marketplace package 성공
- 생성물 재생성, monorepo typecheck, docs/design-system/version/surface-count gates 통과

외부 프로젝트 변경이 필요한 #246과 Windows/D200X 실기 확인은 코드만으로 닫지 않는다.
