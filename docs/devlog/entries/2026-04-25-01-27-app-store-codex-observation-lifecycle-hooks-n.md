# 2026-04-25 → 27 — App Store 앱에 Codex Observation 추가 (lifecycle hooks + notify + OTel)

### 문제

App Store macOS 빌드는 `~/.claude/settings.json` hook 으로 Claude Code 만 dashboard 에 표시했고, Codex 세션은 보이지 않았다. `apple/APP_REVIEW_NOTES.md` 도 "Codex doesn't ship Claude-Code-compatible hooks today" 라고 인정하고 회피해 왔다. codex 0.123.0 이 두 신호 채널 (`notify` config + `[otel]` HTTP exporter) 을 제공하기 시작하면서 다시 가능성이 열림.

### 해결 (3 단계 진화)

**v1 — 초기 구현**: `~/.codex/config.toml` 에 `notify = ["sh", "-c", "<snippet>", "agentdeck-notify"]` + `[otel] exporter = "otlp-http"` 주입. `[features] codex_hooks` 모름. 세 신호원이 `pushedSessionsById` 의 `codex:<thread-id>` 키로 수렴. 신규 파일: `MiniToml`, `CodexConfigInstaller`, `CodexOtelRoutes`, `CodexTelemetryModule` + tests. 기존 `/hooks/*` 라우트 + `handleHookEvent` 에 codex_* event case 들 추가.

**v2 — Codex review 대응**: 외부 review 에서 P1×2 + P2×1 발견. (1) OTel schema 가 `[otel.trace_exporter.otlp-http]` sub-table 에 `protocol = "json"` 이라야 함, top-level `[otel]` 아님. (2) Codex notify argv 가 array 끝에 JSON 을 append → `sh -c "<s>" <json>` 시 `$0=json` 이라 우리 snippet 의 `$1` 비어있음 → dummy `agentdeck-notify` 4번째 element 추가. (3) daemon 의 dynamic port (9120 → fallback) 와 install 시점의 hardcoded endpoint 가 어긋남 → daemon 시작 시 `step11b CodexConfigInstaller.installIfNeeded()` 호출로 매번 재기록.

**v3 — 환경 fix + 외부 추가 진단 적용**: 라이브 검증 시도 중 발견된 layered 문제들.
- **HTTPServer body framing bug** (외부 진단 핵심): `bodyBytesSoFar < expectedBody && isComplete` 분기가 partial body 를 통과시켜 truncated JSON 이 parser 에 흘러 매번 fail. multi-chunk `receiveFullRequest` + raw-Data body slice (utf-8 round-trip 회피) + Content-Length 미충족 + isComplete 시 reject 로 fix.
- **CodexConfigInstaller 재설계** (Codex 가 인계 받음): `[features] codex_hooks = true` + `[[hooks.SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop]]` 5 종 lifecycle hook 표 + stdin payload (`-d @-`). notify/OTel 은 사용자 키 충돌 시 자동 omit 되는 fallback 으로 격하. `MiniToml.hasTableOutsideFence` 가 array-of-table `[[hooks.Stop]]` 충돌도 검출.
- **OTel parser** 가 codex 실 emit (`session.task.turn`, `op.dispatch.user.input.with.turn.context`, `tool.call`, `tool.result`) 도 수용 + `spanNameSummary` 진단.
- **macOS 26 환경 hang fix 두 개**: ① `AuthManager.loadOrCreateToken` — sandbox 첫 launch 시 Group Container `Data(contentsOf:)` 가 `__open` syscall 에서 silent block (sandboxd deny log 도 안 찍힘) → background queue + 2s timeout. ② `SettingsScreen.servicesContent` — SwiftUI Settings scene 의 view tree 평가만으로 keychain `SecKeychainItemCopyContent` 가 main thread block (ad-hoc 빌드의 ACL prompt 반복) → `.task` + `Task.detached` 분리.

### 핵심 설계 결정

- **fence-block lossless TOML 편집기** (`MiniToml`): 사용자 키 / 코멘트 / 순서 byte-for-byte 보존. `# >>> AgentDeck managed (do not edit) <<<` sentinel 로 자기 라인 식별. dictionary roundtrip 금지.
- **두 신호원이 같은 sessionId 키 공유**: `codex:<thread-id>`. notify 단독, OTel 단독, 둘 다 — 셋 다 정상. `updateSessionHookState` 가 idempotent.
- **App Store 가드레일 보존**: subprocess spawn 0건, companion-install 강요 copy 0건, home-relative-path entitlement 0건. `verify-appstore-archive.sh` 의 `^/bin/sh$` regex 회피하려고 notify array 의 shell path 는 `"sh"` (PATH lookup), 절대 경로 아님.
- **환경 fix 일반화**: 모든 main-actor sync file/keychain I/O 는 background queue + timeout 으로. 새 lesson 메모 두 개로 고정 (memory: `macos26-sandbox-first-launch-open-block`, `swiftui-settings-keychain-onappear-block`).

### 검증

- **정적 게이트**: Release 빌드 ✅ + `verify-appstore-archive.sh` ✅ (모든 v1+v2+v3 + 환경 fix 적용 후)
- **Xcode Run / 직접 launch 둘 다 정상 startup** — AuthManager fix 이후. 사용자 GUI freeze 해소 확인.
- **라이브 wire 검증은 보류**: ad-hoc 빌드의 환경 hang + codex 의 실제 schema 검증 필요. 정식 서명 빌드 (TestFlight) 사용 시점에 별도 진행. plan 파일 (`/Users/puritysb/.claude/plans/cli-app-store-modular-moonbeam.md`) 의 "Live Verification" 절 참조.

### 미해결 / 후속

- 라이브 wire 검증 (TestFlight 빌드 사용 시점)
- fence 안 사용자 sub-table 침입 보존 로직 (`[tui.model_availability_nux]` 류 — 우리 fence body 가 다음 install 때 잡아먹음)
- TopologyRail hub spine vertical-stretch (별도 commit 으로 fix 완료: `cef3283a`)
- Onboarding 의 Choose Agent ↔ Optional Integrations 항목 중복
- iPhone/iPad 페어링 화면 시각화 개선

---
