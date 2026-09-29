# 2026-05-03 — OpenClaw 페어링 stuck 진단 + UX/Review-notes 동기화 (16-step)

### 문제

App Store / Group Container 빌드에서 사용자가 Settings → OpenClaw 에 토큰을 저장했음에도
"Awaiting setup" 으로 영구히 머무는 상태. 16 단계에 걸쳐 누적 진단 + fix.

핵심 단서:
- `/status.gateway` = `{available:true, connected:false, authStatus:"gateway_reachable"}`
- 처음엔 silent drop 으로 오인 → 실제로는 OpenClaw 측 ws close 1008 reason 으로 거부 (74건
  누적, 8가지 reason: `device signature invalid`, `device identity required`, `gateway token
  missing`, `unauthorized: device token mismatch`, `invalid handshake`, `invalid connect
  params`, `connect failed`, `unauthorized: too many failed authentication attempts`).
- 사용자 Web UI 도 unauthorized 라며 token 입력 요구 → SPA bundle 분석 결과 OpenClaw
  control-ui 자체에는 token UI 가 없고 (`Chat settings` / `Search settings` 만), token 은
  `~/.openclaw/openclaw.json` 의 `auth.token` (plaintext) 으로만 관리.

### 해결 (16-step 정리)

1. **shared-token 분기 제거** (`OpenClawAdapter.swift sendConnectRequest`) — 옛 `shouldSendDeviceAuth = hasDeviceToken || !hasSharedToken` 분기가 dmPolicy=pairing 환경의 첫
   페어링을 막고 있었음.
2. **RPC error 기반 fallback** — `device_auth_invalid` 응답 + flag 미설정 → flag set + 즉시 retry.
3. **Fallback 시 device 자격증명 전체 차단** — `params["device"]`/`auth["deviceToken"]`/`scopes`
   모두 제거. 진짜 token-only 보장.
4. **close-reason aware fallback** — RPC 응답 안 오는 transport-level 1008 close 도
   `receiveLoop` 가 `task.closeCode/closeReason` 추출 → `handleDisconnect` 가 reason 별 분기.
5. **`expectingClientInitiatedClose` flag** — fallback 의 `wsTask.cancel` 이 receiveLoop 의 close
   event 를 트리거 → 그 close 의 server reason 이 다시 fallback exhausted 분기로 들어가
   `pairingRequired=true` 차단 = 자기-차단. flag 로 직후 1회 close 만 reason 분기 skip.
6. **narrow restart** — `daemonService.restart()` (daemon 전체 재시작 → Claude Code/Codex
   sessions 끊김) 대신 `reconnectGatewayAdapter()` (OpenClaw adapter 만 bounce). DaemonServer
   에 public `reconnectGatewayAdapter()` 추가, DaemonService 에 forward.
7. **NSOpenPanel token import** — Settings → OpenClaw troubleshoot row 에 "Import token" 버튼.
   `NSOpenPanel` user-selected scope (`com.apple.security.files.user-selected.read-write`,
   `startAccessingSecurityScopedResource()` + `defer stop`) → `Data(contentsOf:)` →
   `JSONSerialization` → `auth.token` 만 사용 → Keychain 저장 → adapter reconnect.
8. **`getpwuid(getuid()).pw_dir`** — `panel.directoryURL` 을 사용자 real home 으로 set.
   `NSHomeDirectory()` / `$HOME` env 는 sandbox 안에서 container path 반환 → real home 못
   가리킴. `getpwuid` 패턴 (memory `swift-daemon-server.md`) 사용. NSOpenPanel 은 Powerbox
   에서 동작하므로 sandbox-external path 를 navigation hint 로 받아도 권한 위반 아님.
9. **`OpenClawDeviceIdentityStore`** — Keychain self-gen identity 삭제 정적 메서드. Settings 의
   "Reset pairing identity" 버튼이 호출 → 다음 connect 에 fresh Ed25519 키쌍 생성.
10. **App Store reachable 카피 정정** — "Start OpenClaw" 같은 launch-instruction 제거 ("When
    OpenClaw is running, ..." conditional 형태). App Review 4.2.3 sensitivity.
11. **사용자 카피 vs review notes 톤 분리** — 같은 행위를 reviewer 정확성 톤 (overstatement
    제거: "uses only X" / "saves only X" / "persists only X") 과 사용자 친근 톤 (path hint
    포함) 으로 분리 작성. 사용자가 옵션 1 (path hint 포함) 선택.
12. **`APP_REVIEW_NOTES.md` 동기화** (4 라운드) — line 70 + line 75 cross-reference 일관성:
    `directoryURL` set 동작, `~/.openclaw/` enumerate 안 함, "hardcode" 의 두 의미 (string
    literal in copy vs runtime file-system target) 분리. line 70 의 "never sets directoryURL"
    → "never points it *at* `~/.openclaw/`" 로 좁힘.
13. **`.help(_:)` markdown warning 해소** — SwiftUI `.help(_:)` 의 default `LocalizedStringKey`
    overload 가 backtick/em-dash/quote 를 styled run 으로 파싱 → "Only unstyled text" warning.
    4 곳 (line 602, 1072, 1083, 1092) 모두 `.help(Text(verbatim:))` overload 로 wrap.
14. (그 외 단계 8/13/14 의 false claim 정정 — "(sandbox-internal)" 잘못된 claim 제거 등 누적)
15. **`docs/appstore-feature-matrix.md` 갱신** — CLAUDE.md invariant ("Feature matrix is canonical.
    New features land in the table before any implementation touches the App Store target") 준수.
    OpenClaw 행에 4 개 새 row 추가: shared-token Keychain 저장, shared-token import from JSON
    config (NSOpenPanel + user-selected scope + getpwuid real home), device pairing identity
    reset (`reconnectGatewayAdapter` only, sessions 영향 없음), Web UI deep link
    (`NSWorkspace.open`). 각 행에 entitlement + blast radius 명시.

### 핵심 설계 결정

| 결정 | 이유 |
|---|---|
| RPC fallback + transport (close-reason) fallback **둘 다 유지** | OpenClaw 가 모드/버전에 따라 RPC error vs ws close 둘 다 사용 |
| `disableDeviceAuthForNextConnect` 는 sharedToken 유무 무관 트리거 | Xcode Debug vs App Store keychain access group 차이로 token 못 읽는 환경에서도 fallback 동작 |
| `directoryURL = real home` (sandbox-external) | NSOpenPanel 은 Powerbox 라 권한 위반 아님; container path 는 OpenClaw 가 없는 곳이라 무의미 |
| 사용자 facing path hint vs runtime hardcode 분리 | App Review invariant 는 runtime file-system target 만 의심, copy 의 string literal 은 무관 |
| Reviewer 정확성 톤은 review notes 만, 사용자 카피는 친근 톤 | 같은 행위라도 audience 별 wording 분리. "reads only X" vs "uses only X" 처럼 동사 정확성 |

### 미해결 (사용자 측 영역)

우리 16 단계 fix 후에도 OpenClaw v2026.4.14 가 우리 v3 Ed25519 서명을 `DEVICE_AUTH_SIGNATURE_INVALID`
로 거부 + Web UI 가 `device token mismatch (rotate/reissue device token)` 안내. 진짜 root cause
는 OpenClaw 측 v3 verify 코드 또는 token state stale. 사용자 (OpenClaw 운영자) 가 직접 점검:

1. `openclaw update` (v2026.4.14 → v2026.4.26) — gateway.log 에 update available 알림.
2. `~/.openclaw/openclaw.json` 의 `auth.token` 새 값 발급 → Gateway 재시작 → AgentDeck Import
   token 다시.
3. `device-pair` 플러그인의 v3 verify 함수가 `docs/gateway-protocol.md` line 55-71 의 spec
   대로 reconstruct 하는지 직접 확인.

---
