# 2026-05-10 — App Store release readiness: APME dashboard + Device Preview catalog

### 문제

App Store 제출 전 점검에서 Evaluation(APME) 과 Device Preview 표면에 실제 동작/문서
불일치가 있었다.

- APME dashboard 는 `/apme?token=...` 로 열리지만 후속 `fetch('/apme/runs')`,
  `fetch('/apme/run/...')`, `POST /apme/vibe` 에 token 을 붙이지 않았다. Node
  daemon 의 APME 라우트는 token-gated 라서 평가 UI 가 401 로 비어 보일 수 있었다.
- Swift APME HTTP detail payload 가 `vibe` 와 `turnEvals` 를 싣지 않아 App Store
  in-process daemon 에서는 vibe column / turn-level judge 점수가 dashboard 에 반영되지
  않았다.
- Swift eval result timeline append 는 저장만 하고 `timeline_event` broadcast 를 하지
  않아 live dashboard/device timeline 에 ★ eval_result 행이 즉시 뜨지 않았다.
- Device Preview 문서/주석은 "14 targets" 라고 쓰여 있었지만 실제 catalog 는 16개,
  App Store standalone visible set 은 ADB-tier 4개를 숨긴 12개였다.

### 해결

- APME dashboard HTML(TS source + App Store bundled resource)에 `api(path)` helper 를
  추가해 현재 URL 의 `token` 을 모든 APME fetch/POST 에 전파.
- Swift `ApmeHttpRoutes` 를 Node shape 에 맞춰 보강: schema envelope, `/apme/run/<id>`,
  `vibe`, per-turn `turnEvals`, authenticated UI routes, GET/POST recommend parity.
  FoundationModels judge relay endpoint 은 Node runner 호환을 위해 기존처럼 same-machine
  POST 로 유지.
- `appendEvalResultTimeline` 이 `timeline_event` 를 즉시 broadcast 하도록 수정하고,
  `layer1SkippedReason` 을 WS/HTTP payload 에 실어 App Store LLM-only 평가 상태가
  dashboard 에 표시되게 함.
- APME empty-state copy 에서 "Launch a session from the menubar" 문구를 제거하고,
  사용자가 자기 workspace 에서 agent 를 실행한다는 App Store-safe copy 로 정리.
- Device Preview catalog count 를 16 total / 12 standalone / 4 desktop-bridge 로 문서화하고
  `APP_REVIEW_NOTES.md`, `docs/appstore-feature-matrix.md` 를 실제 UI 정책에 맞춤.
- APME runner 테스트가 실제 사용자 App Store container 의 `daemon.json` 상태에 의존하지
  않도록 FoundationModels fallback 테스트에 임시 `AGENTDECK_DATA_DIR` 를 주입.
- Vitest 전역 setup 에서 worker 별 임시 `AGENTDECK_DATA_DIR` 를 설정해 전체 test suite 가
  로컬 설치/실행 중인 AgentDeck daemon 상태에 의존하거나 hang 하지 않도록 격리.
- Stream Deck plugin `ConnectionManager` 도 `AGENTDECK_DATA_DIR` override 를 존중하게 해
  테스트/개발 환경에서 App Store container fallback 파일을 직접 읽지 않도록 수정.

---
