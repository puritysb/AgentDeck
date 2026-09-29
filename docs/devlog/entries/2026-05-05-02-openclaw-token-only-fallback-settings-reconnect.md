# 2026-05-05 — OpenClaw token-only fallback 무응답 타임아웃 + Settings reconnect

### 문제

Xcode-run App Store-gated macOS 앱에서 OpenClaw Gateway TCP/health 는 정상이고
Settings → Integrations 에서 `openclaw.json` 토큰도 Keychain 에 저장되어 있었지만, Dashboard 는
`gatewayAvailable=true`, `gatewayConnected=false`, `gatewayAuthStatus=gateway_reachable` 로
"Awaiting setup / Connecting to Gateway" 에 머물렀다. Swift daemon 로그상 첫 `connect` 는
`DEVICE_AUTH_SIGNATURE_INVALID` 로 거부되고, 그 뒤 token-only fallback 이
`fallback=true hasDevice=false hasSharedToken=true hasDeviceToken=false` 로 전송되지만 Gateway 응답이
돌아오지 않았다. 기존 Swift 어댑터는 fire-and-forget `connect` RPC 에 timeout 이 없어 이 상태를
명시 실패나 재시도로 전환하지 못했다.

### 해결

- `OpenClawAdapter` 의 pending RPC 에 timeout 을 추가했다. 특히 `connect` RPC 무응답은 socket 을
  닫아 기존 reconnect 루프로 복귀시키고, 첫 device-auth connect 가 조용히 drop 되면 token-only
  fallback 으로 한 번 전환한다.
- token-only fallback connect 까지 timeout 되면 `connect_timeout` auth status 를 내보내 UI 가
  무한 "Connecting" 으로 남지 않게 했다.
- `ADGatewayFrame` 디코드가 큰 `hello-ok` payload 에서 실패해도 raw JSON envelope 의
  `type=res/event` 로 response/event 를 처리하게 했다. Gateway 가 실제로 `ok=true` 를 보냈는데
  Swift 가 payload union 디코드 실패 때문에 응답을 drop 하는 경로를 막는다.
- Settings → OpenClaw troubleshoot row 에 명시적 **Reconnect adapter** 버튼을 추가했다. 토큰 입력칸
  Save 버튼이 빈 입력 때문에 비활성화된 상황에서도 daemon 전체 restart 없이 OpenClaw adapter 만
  bounce 할 수 있다.

### 검증

- Xcode-run diagnostics: Gateway `available=true`, `connected=false`, `authStatus=gateway_reachable`,
  Swift log 에서 token-only fallback 무응답 확인.
- OpenClaw `gateway.err.log`: AgentDeck 첫 시도는 `code=1008 reason=device signature invalid` 로
  닫힘.
- `git diff --check` 성공.
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataOpenClawConnectTimeout CODE_SIGNING_ALLOWED=NO` 성공.
- Xcode 종료 후 새 Debug `.app` 직접 실행 검증: 수정 전에는 Dashboard/Settings 가 `Handshake
  timeout` / `connect_timeout` 을 표시하고, Settings 의 **Reconnect adapter** 클릭 시 adapter-only
  reconnect → token-only fallback → 10s timeout 으로 다시 수렴했다.
- raw-envelope fallback 수정 후 새 Debug `.app` 재실행 검증: `/status.modules.gateway` =
  `{available:true, connected:true, authStatus:"connected"}`, `sessions=1`. Swift log 에
  `connect ok=true`, `sessions.subscribe ok=true`, `health ok=true`, `sessions.list ok=true`,
  active session `agent:main:main` 확인.

---
