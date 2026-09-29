# 2026-08-15 — Kiro passive observation foundation (no managed launch)

Issue #103의 Kiro 요청을 현재 제품 방향에 맞춰 조사·구현했다. 결론은 새
`agentdeck kiro` PTY를 만드는 것이 아니라 사용자가 평소처럼 실행한 `kiro-cli` /
Kiro IDE 위에 daemon 관측을 붙이는 것이다.

- 로컬에 공식 Kiro CLI 2.18.1을 설치하고 Google 로그인 뒤 실제 대화를 실측했다.
  이 버전은 예상한 JSONL이 아니라 macOS app-data의 `kiro-cli/data.sqlite3`
  `conversations_v2`에 완료된 턴을 저장한다. observer는 이 DB에서 cwd/session id/
  timestamp/model과 대화 상태에 필요한 열만 read-only + query-only로 읽고 auth·telemetry
  테이블은 건드리지 않는다. v3는 별도로
  `KIRO_HOME/sessions/<workspace-hash>/<session>/session.json` + `messages.jsonl`을
  쓰는 것을 실측해 `payload.type`의 user/assistant/turn_start/turn_end를 읽는다.
  flat `sessions/cli` reader와 ACP schema 처리는 legacy fallback으로 유지한다.
- 응답 중에는 DB row가 아직 갱신되지 않지만 `~/.kiro/.cli_bash_history` mtime은 프롬프트
  제출 즉시 바뀐다. 텍스트를 읽지 않고 이 mtime이 최신 conversation timestamp보다
  새로운 동안만 최신 세션을 processing으로 표시한다(동시 다중 chat은 best-effort).
- `PassiveSessionObserver`는 `kiro-cli`/`kiro` 프로세스 cwd와 가장 최근의 같은-cwd
  세션을 결합해 `observed:kiro:<id>`를 만든다. Kiro IDE가 ACP child를 소유하면
  `kiro-ide`로 귀속하고 IDE parent 행은 중복 생성하지 않는다. 세션 파일을 못
  찾더라도 process-only idle 행은 유지한다.
  공식 launcher가 만드는 wrapper → `kiro-cli-chat` child는 child 하나로 collapse하고,
  상주 `kiro_cli_desktop --no-dashboard` 및 login/doctor 같은 관리 명령은 제외한다.
- 후속 최신 문서/로컬 실측에서 이 결론을 정정했다. Kiro CLI 2.13부터 **v3 엔진에
  한해** `~/.kiro/hooks/*.json` 전역 훅이 공식 지원된다. 2.18.1 `kiro-cli --v3`
  TUI에 임시 v1 hook을 걸어 `SessionStart → UserPromptSubmit → Stop`이 동일 session id와
  cwd로 발생함을 확인했다(비대화형 `--no-interactive`는 이번 실측에서 훅을 로드하지
  않았다). `@agentdeck/hooks`와 setup에 `agentdeck-lifecycle.json` installer를 추가했고,
  모든 이벤트를 `kiro_*` agent-neutral boundary로 fire-and-forget 전송한다. 따라서
  사용자는 계속 native Kiro를 실행하고 AgentDeck는 그 위에 붙으며, v2는 SQLite/
  process 관측, v3는 global hook + nested JSONL의 정밀 경로를 쓴다.
- AgentType/생성 프로토콜/TS·Swift·Kotlin·ESP32 라벨과 브랜드 색상/TUI 표면에
  `kiro-cli`와 `kiro-ide`를 추가했다. 크리처는 임의 동물이나 재작성 로고가 아니라
  issue가 지정한 MIT 배포물 `@lobehub/icons-static-svg@1.94.0`의 `kiro.svg`를 정확히
  고정했다. 제보자의 공개 프로필에 AWS 재직 정보가 있는 것은 요청의 신뢰 신호로만
  취급했고 상표 사용 허가로 보지 않았다. 패키지 버전·npm integrity·원본 URL과
  비제휴/비보증 상표 경계를 `design/RESOURCES.md`에 기록했다.
- 이 SVG를 기존 brand/glyph 파이프라인에 넣어 64×64 creature mask와 24/9/8px
  dot glyph를 생성하고, shared SVG, Android color/e-ink 테라리움, Apple 미리보기,
  Pixoo full/compact/micro, ESP32 InkDeck/knob/office 표면에 연결했다. Android에서도
  `kiro-cli`/`kiro-ide`가 기본 문어로 fallback하지 않고 동일한 ghost path를 그리며,
  이동/상태 배치는 기존 vector-mark creature mechanics를 재사용한다.
- 다음 단계로 데몬이 없어도 실행되는 `agentdeck diag kiro [--json]`를 추가했다.
  native Kiro 프로세스/SQLite·JSONL store/schema marker/cwd·resume-id 상관관계만
  보고한다. 프롬프트·응답·tool input·명령행·세션 제목·모델명·TTY 이름은 보고서
  구조에 없고, cwd와 session id는 보고서마다 새 salt를 쓰는 opaque key로 바뀐다.
  따라서 사용자가 issue에 그대로 첨부해도 프로젝트명이나 대화 내용이 노출되지 않는다.

검증: 공식 CLI 2.18.1 설치/Google 로그인 후 v2와 v3 실제 대화를 수행했다. v2는
SQLite에서 idle/processing/idle 및 resume-id exact correlation을, v3는 nested JSONL
schema와 global hook lifecycle을 확인했다. 로컬 daemon APME에도 `kiro-cli` run 1개와
완료 turn 1개가 기록됐다. 전체 workspace build/typecheck, Vitest 190 files / 3053 tests,
Android JUnit/Robolectric 375 tests, macOS Debug build, ESP32
`ips35`/`inkdeck`/`t_embed` build와 preview/design sync gate가 후속 변경까지 포함해
통과했다.
