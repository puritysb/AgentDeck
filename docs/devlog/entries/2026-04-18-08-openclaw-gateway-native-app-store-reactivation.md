# 2026-04-18 — OpenClaw Gateway-native App Store reactivation

### 목표
`a2b2dbfe` 의 App Store `return nil` 차단은 외부 파일/CLI/subprocess 경로 제거에는 맞았지만, OpenClaw 자체를 "unsupported" 로 고정했다. 이번 작업은 해당 차단을 삭제하지 않고 **App Store 빌드에서만 Gateway WebSocket RPC 경로로 대체**한다. CLI/Homebrew 빌드는 기존 `~/.openclaw/identity/*` + `openclaw ...` fallback 을 계속 primary 로 유지한다.

### 구현
- `shared/src/gateway-protocol.ts` 를 OpenClaw 2026.4.14 surface 에 맞춰 확장: `hello-ok.auth.deviceToken`, `health`, `models.list`, `logs.tail`, `sessions.subscribe`, `sessions.messages.subscribe`, `sessions.changed`, `session.message`, `session.tool`, `system-presence`.
- parity fixtures 추가 후 `pnpm generate-protocol` 로 `generated/protocol/GatewayFrame.*` / schema 갱신.
- `OpenClawAdapter` App Store 경로:
  - Keychain service `bound.serendipity.agentdeck.dashboard.openclaw.identity`
  - `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`
  - Access Group 없음
  - self-generated Ed25519 keypair, `deviceId = sha256(raw 32-byte public key).hex`
  - v3 payload `v3|deviceId|clientId|clientMode|role|scopesCSV|signedAtMs|token|nonce|platform|deviceFamily`
  - `hello-ok.auth.deviceToken` 저장 + reconnect 재사용
- App Store `models.list` / `health` / `logs.tail` 은 Gateway RPC 로 대체. `BridgeLogStream` 의 subprocess tailer는 non-App-Store 전용으로 유지.
- `DaemonServer` 에 OpenClaw auth/pairing 상태 캐시 추가: `gateway_not_found`, `gateway_reachable`, `pairing_required`, `approval_pending`, `connected`, `auth_failed`, `token_mismatch`, `device_auth_invalid`, `unsupported_protocol`.
- Settings / Tank status copy 를 "Unavailable" 에서 pairing-aware 안내로 전환. App Store identity 는 기존 CLI identity 와 분리되며, 사용자는 `openclaw devices list` / `openclaw devices approve <requestId>` 또는 Web UI(`http://localhost:18789`)에서 승인한다.

### 검증
```
pnpm --filter @agentdeck/shared typecheck
pnpm vitest run bridge/src/__tests__/gateway-parity-fixtures.test.ts
xcodebuild -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination platform=macOS,arch=arm64 build
```

---
