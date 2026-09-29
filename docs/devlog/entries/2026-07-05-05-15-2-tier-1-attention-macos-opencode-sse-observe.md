# 2026-07-05 — 라운드 15: 2-티어 제품 공식화 — Tier 1 attention 복원 + macOS 알림 + OpenCode SSE observer + 문서 정합

### 배경 (제품 방향)
1차 목표 = **App Store Swift 앱 단독(Tier 1)** 으로도 완결된 모니터링 대시보드; `agentdeck` CLI 추가 설치 시(Tier 2) PTY 스티어링·구독 사용량이 얹히는 순수 업그레이드 구조로 층위 확정. 조사 결과 구조는 ~80% 기구현(HookInstaller 앱 내 hook 설치, Swift 데몬 hook 인제스트, 9120 중재, `isUsingExternalDaemon` 게이트) — 남은 품질 격차 3건 + 문서 공식화를 수행.

### 1 — display-only attention 복원 (Swift + Node, `765a1023` 부분 복원)
2026-06-27 커밋이 PreToolUse 가짜 Allow/Deny 게이트를 제거하면서 **Notification 기반 display-only awaiting까지 함께 제거**했었음. 실패 원인은 PreToolUse(자동승인 툴에도 발화)였지 Notification이 아님 — `notification_type: "permission_prompt"` 는 실제 권한 프롬프트가 표시될 때만 발화하는 진짜 대기 신호. 분류기(`isPermissionNotification`)는 양쪽에 살아있었고 Node `awaiting-overlay.ts` 는 고아 모듈이었음.
- Swift: `DaemonServer` `case "notification"` no-op → awaiting_permission + question(120자) 복원. options/requestId 없음 → 전 표면 "Respond in the terminal" 경로(UI 변경 0).
- Node: `daemon-server.ts` 에 `setAwaitingOverlay`(requestId 없이) + 후속 hook clear + `applyAwaitingOverlayToObserved` enrich 재배선. held-gate/`permission-resolver` 호출부는 계속 제거 상태.
- vitest 에 display-only 계약 테스트 추가 (requestId undefined 단언 + idle ping 거부).

### 2 — macOS 시스템 알림 (`AttentionNotifier.swift` 신규)
`AgentStateHolder` sessionsList diff 에서 awaiting 진입 시 UN notification post / 이탈 시 clear (identifier=sessionId 로 교체·잔존 방지, 디듀프 맵). **앱 레이어 배치라 양 티어 공통**. `AppDelegate` 에 `UNUserNotificationCenterDelegate` 채택(포그라운드 배너). 기존 `NotificationPermission` 동의 흐름 재사용 — 이 파일의 과장된 주석도 실제 포스트 지점 서술로 정정.

### 3 — Tier 1 OpenCode 모니터링 (opt-in 기본 OFF, Swift SSE observer 신규)
- `ProcessEnumerator.swift` — `LocalCodexAppObserver` 의 sysctl KERN_PROC_ALL/PROCARGS2 헬퍼를 공용 추출.
- `OpenCodeSSEClient.swift` — `opencode-client.ts` read-only 포팅 (`/global/health`·`/session/status`·`/session/{id}`·SSE `/global/event`). 프레임 파서/이벤트 분류기 = `nonisolated static` 순수함수(XCTest 13개).
- `OpenCodeObserver.swift` — 발견 3경로(사용자 URL / `opencode serve` 기본 4096 프로브(GatewayProbe 선례) / sysctl argv 명시적 `--port`, agentdeck-managed 제외). **기본 TUI(랜덤포트)는 의도적 발견불가 — 포트스캔 금지**. 5s tick = keepalive(180s TTL 리핑 방지) + 재연결 백오프. OFF 면 프로브 0회.
- `DaemonServer.handleOpenCodeObserverUpdate` — Codex OTel 경로와 동일 계약(`pushedSessionsById`+`lastHookAtByPushedSession`+broadcast-on-change). `permission.requested` = display-only awaiting(Node adapter 의 Allow/Deny 조작 미포팅). 연결 시 busy 세션 seed.
- Settings → Integrations 에 OpenCode 행(카탈로그+status evaluator+토글/URL 슬롯). 카피는 설정 사실 서술만(4.2.3).

### 4 — 문서 공식화
- `docs/appstore-feature-matrix.md`: 선두 "Two-tier product" 절 + **Guard conventions**(실 options[]만 렌더 / observed 는 requestId 금지 / `isPermissionNotification` SSOT / PreToolUse 게이팅 금지) 신설. "Permission prompt 표시" 행을 notification_type 시맨틱으로 정정(그동안 코드와 불일치했음), "Device approval gating" 행 ❌/❌ 로 정정(양쪽 제거 사실 반영), OpenCode 행 ⚠️ opt-in 으로 갱신.
- `APP_REVIEW_NOTES.md`: `settings.local.json`→`settings.json` drift 3곳(App Store 앱은 settings.json 대상 — Node CLI 는 여전히 settings.local.json 이 맞음), OpenCode 절을 opt-in localhost SSE 클라이언트 서술로 재작성(OpenClaw 절 모델), Local notifications 절 신설.
- README: App Store 절 앞에 Two-tier 업그레이드 서사(업그레이드 유도는 README/문서만 — 인앱 금지), :290 drift 수정. metadata draft·QA checklist 의 settings.json drift 도 수정.

### 검증
vitest 1625/1625, macOS XCTest 352/352(신규 OpenCodeObserverTests 13 포함), macOS+iOS 빌드 SUCCEEDED, xcodegen pbxproj 커밋.
