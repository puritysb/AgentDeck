# 2026-04-21 — OpenClaw Gateway 공유 토큰 인증 디버깅

### 문제
macOS App(App Store 빌드)에서 Settings → OpenClaw Gateway Advanced에 토큰을 저장해도 인증이 안 되는 문제. 순서대로 발생한 오류:
1. `gateway_token_missing` — 토큰이 아예 전송 안 됨
2. `device_auth_invalid` — 토큰 전송 후 디바이스 서명 거부, Web UI에 승인 항목도 안 뜸
3. 연결은 됐지만 OpenClaw 세션/액션 정보가 안 나옴

### 해결

**원인 1: `pairingRequired` 과도 적용 → 재연결 영구 차단**

`gateway_token_missing` 에러에도 `pairingRequired = true`가 설정되어 어댑터가 재연결을 영구 차단했다. `handleResponse`에서 Web UI 조치가 필요한 상태(`pairing_required`, `device_auth_invalid`, `approval_pending`, `unsupported_protocol`)에만 `pairingRequired = true`를 설정하도록 범위 축소.

**원인 2: 공유 토큰 모드에서 device auth를 함께 전송 → DEVICE_AUTH_INVALID**

Gateway shared-token 모드는 device 승인이 불필요한데 device auth(Ed25519)를 같이 보내면 Gateway가 미등록 디바이스로 거부한다. `sendConnectRequest`에서 device auth 전송 조건을 변경:
- device auth token이 있을 때(이전에 페어링됨) → 전송
- shared token만 있을 때(최초 연결) → 전송 안 함
- 아무 토큰 없을 때(device-pairing 모드) → 전송

**원인 3: `sessions.subscribe` 실패 시 무음 처리**

`sessions.subscribe` 실패 → `sessions.changed` 이벤트 미수신 → 새 세션 시작을 감지 못 함. 대응:
- 모든 non-connect RPC 실패에 에러 로깅 추가
- `sessions.subscribe` 응답이 `subscribed: false`면 15초 폴링 fallback 자동 시작

**부수 수정**

- DaemonServer: 세션 resurrection(daemon 재시작 중 hook 이벤트 수신 시 세션 자동 생성), 자가 probe 스킵
- IntegrationsView: `token_mismatch`("잘못된 토큰 붙여넣기")와 `device_auth_invalid`("Web UI 승인 필요") 메시지 분리. `device_auth_invalid`는 첫 연결 시 정상 흐름이므로 빨간 "Auth failed" → 주황 "Awaiting"으로 변경
- TopologyRail/IntegrationsView: Claude row를 hooks OR OAuth 둘 중 하나만 활성이어도 "Connected"로 표시

### 핵심 설계 결정

**OpenClaw Gateway auth 모드 2가지 (Swift 어댑터 기준)**

| 모드 | 조건 | connect params |
|------|------|----------------|
| Shared-token 전용 | `sharedToken != nil && deviceToken == nil` | `auth.token = sharedToken` only |
| Device-pairing 전용 | `sharedToken == nil` | `device` auth (empty device token in sig) → Gateway issues pairing request |
| 페어링 완료 재연결 | `deviceToken != nil` | `device` auth + `auth.deviceToken` |

**pairingRequired = true 적용 기준**

`pairing_required`, `device_auth_invalid`, `approval_pending`, `unsupported_protocol` → reconnect 차단. `gateway_token_missing`, `token_mismatch` → 차단 안 함(사용자가 Settings에서 수정 가능한 설정 오류).

**세션 subscription fallback**

Gateway가 `sessions.subscribe`를 지원하지 않거나 권한 부족으로 실패하면 15초 폴링으로 자동 전환. `sessionsSubscribed` 플래그로 추적.

---
