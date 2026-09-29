# 2026-04-26 — Codex observation: HTTP body framing fix + lifecycle hooks primary

### 문제

Codex OTel POST 진단에서 `Content-Length` 는 큰 값인데 daemon 이 65 KB 안팎의 partial body 를 JSON parser 로 넘기고 있었다. 기존 `HTTPServer.receiveFullRequest` 는 `isComplete == true` 를 "요청 body 완료"로 해석해 `bodyBytesSoFar < Content-Length` 상태도 통과시켰고, 그 결과 OTel JSON 은 항상 prefix만 들어와 parse 불가였다.

동시에 Codex observation 의 큰 설계도 notify + OTel 중심이라 불안정했다. 현재 Codex 공식 docs 에는 `[features] codex_hooks = true` + inline `[[hooks.*]]` lifecycle hook 이 있고, command hook 이 stdin 으로 JSON payload 를 받는 경로가 존재한다.

### 해결

- `HTTPServer.receiveFullRequest` 에서 `Content-Length` 미충족 + `isComplete` 인 경우 partial request 를 reject 하도록 변경. body extraction 도 header string 재조립이 아니라 raw `Data` slice 로 유지.
- `CodexConfigInstaller` 를 lifecycle hooks primary 로 재구성:
  - `[features] codex_hooks = true`
  - `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` inline hook tables
  - hook command 는 stdin JSON 을 그대로 `/hooks/codex_session_start`, `/hooks/codex_user_prompt_submit`, `/hooks/codex_tool_start`, `/hooks/codex_tool_end`, `/hooks/codex_stop` 로 POST
  - user `notify` / `[otel]` 이 없을 때만 optional fallback/exporter 유지
- user-authored `[features]` / `[hooks]` 는 unsafe merge 하지 않고 설치 abort. `MiniToml.hasTableOutsideFence` 는 `[[hooks.Stop]]` 같은 array-of-table 도 conflict 로 잡도록 보강.
- daemon hook router 에 `codex_*` 이벤트를 추가하고 Codex session id 를 `codex:<session/thread>` 로 namespace 해서 Claude 세션과 충돌하지 않게 했다. Codex 이벤트는 APME Claude hook collector 로 흘리지 않는다.
- OTel parser 는 실제 관찰된 `op.dispatch.user_input_with_turn_context`, `session_task.turn`, `thread.id`, `turn.id` 계열도 best-effort 로 인식하고, unknown span batch 는 span name summary 를 로그에 남긴다.
- App Store feature matrix / review notes 를 lifecycle hooks primary + notify/OTel fallback 설명으로 갱신.

### 검증

- `xcodebuild build -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataCodexHooksBuild CODE_SIGNING_ALLOWED=NO` 성공
- `xcodebuild build-for-testing -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataCodexHooksBFT CODE_SIGNING_ALLOWED=NO` 성공
- `xcodebuild build -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Release -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataCodexHooksRelease CODE_SIGNING_ALLOWED=NO` 성공
- `bash apple/scripts/verify-appstore-archive.sh /tmp/AgentDeckDerivedDataCodexHooksRelease/Build/Products/Release/AgentDeck.app` 성공
- 실제 `xcodebuild test -only-testing:...` 는 host app XCTest launch 단계에서 출력 없이 멈춰 중단. 테스트 bundle compile 은 `build-for-testing` 으로 확인.

---
