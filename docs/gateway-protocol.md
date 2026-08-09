---
id: arch.gateway-protocol
title: Gateway Protocol
description: OpenClaw Gateway WebSocket — frame format, Ed25519 handshake, RPC and event catalog, versioning rules.
category: Specs
locale: en
canonical: true
status: stable
owner: Gateway maintainers
reviewed: 2026-07-21
revision: 2026-07-21
source_of_truth: docs/gateway-protocol.md
validators: [pnpm test]
---
# Gateway Protocol (OpenClaw)

AgentDeck의 `openclaw` 어댑터가 OpenClaw Gateway(기본 포트 `18789`)에 연결할 때 사용하는 WebSocket 프로토콜 스펙. Node 어댑터(`bridge/src/adapters/openclaw.ts`)와 Swift 어댑터(`apple/AgentDeck/Daemon/Gateway/OpenClawAdapter.swift`)가 **동일한 와이어 포맷**을 주고받는다.

타입 단일 소스: [`shared/src/gateway-protocol.ts`](../shared/src/gateway-protocol.ts). `pnpm generate-protocol`로 Swift/Kotlin 바인딩을 `generated/protocol/GatewayFrame.{swift,kt}`에 생성하며, CI가 drift를 차단한다.

## 프레임 포맷

모든 메시지는 JSON으로 인코딩되고 `type` 디스크리미네이터로 구분된다.

```ts
type GatewayFrame = GatewayRequestFrame | GatewayResponseFrame | GatewayEventFrame;

interface GatewayRequestFrame  { type: 'req';   id: string; method: string; params: object; }
interface GatewayResponseFrame { type: 'res';   id: string; ok: boolean; payload?: any; error?: { code; message; details? }; }
interface GatewayEventFrame    { type: 'event'; event: string; payload: object; seq?: string; stateVersion?: string; }
```

주의: **JSON-RPC가 아니다.** 필드 이름(`type`, `id`, `method`, `params`, `ok`, `payload`, `event`)은 커스텀이다.

## 핸드셰이크 (Ed25519 device auth)

```
Client                               Gateway
  │                                    │
  │ ─── WebSocket connect ────────────→│
  │                                    │
  │←─── event connect.challenge ───────│
  │       { nonce }                    │
  │                                    │
  │ ─── req connect ──────────────────→│
  │    { auth: { id, publicKey,        │
  │             signature, signedAt,   │
  │             nonce },               │
  │      requestScopes }               │
  │                                    │
  │←─── res connect { ok: true } ──────│
  │                                    │
  │ ─── req sessions.list ────────────→│
  │←─── res sessions.list ─────────────│
  │                                    │
  │ ══ normal traffic (chat.* etc.) ══ │
```

서명 페이로드는 2가지 포맷이 공존한다:

**v2** (Node CLI bridge — file-based identity):
```
v2|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce
```
- `deviceId`: `~/.openclaw/identity/device.json`의 `deviceId`
- `token`: `~/.openclaw/identity/device-auth.json`의 `tokens.operator`
- Ed25519 공개키는 SPKI DER 앞 12바이트(`ED25519_SPKI_PREFIX_LEN`) 제거한 raw 32바이트의 base64url.

**v3** (App Store 빌드 — self-generated identity, OpenClaw 2026.4.14+):
```
v3|deviceId|clientId|clientMode|role|scopesCSV|signedAtMs|token|nonce|platform|deviceFamily
```
- `deviceId`: **self-generated** Ed25519 공개키(raw 32바이트)의 SHA-256 hex. 앱이 직접 생성하므로 파일 I/O 없음.
- `token`: 첫 pairing 직후 Gateway 가 `hello-ok.auth.deviceToken` 으로 발급. 이후 재접속은 이 토큰 재사용.
- `platform`: `darwin` / `deviceFamily`: `mac`.
- Private key + issued token 은 Keychain (accessibleAfterFirstUnlockThisDeviceOnly)에 저장.

공통:
- `clientId`: `gateway-client`.
- `clientMode`: `backend`.
- `role` / `scopes`: App Store 는 기본 `operator` + `[operator.read, operator.write, operator.approvals]`. device-management UI 필요 시 `operator.pairing` opt-in.
- `signedAtMs`: `Date.now()`.
- `nonce`: `event connect.challenge` 에서 수신.

> **샌드박스 호환**: App Store macOS 빌드는 `~/.openclaw/identity/` 읽기 불가이므로 v3 self-gen 경로로 동작. Node CLI bridge (`@agentdeck/setup`) 는 v2 file-based 경로 유지. OpenClaw Gateway 는 두 포맷 모두 수용 (Gateway 2026.4.14+).

## RPC 메소드

| Method                    | Params                                       | Result                   |
|---------------------------|----------------------------------------------|--------------------------|
| `connect`                 | `{ auth, requestScopes, clientInfo? }`       | `{ accepted, sessionToken?, expiresAt? }` |
| `chat.send`               | `{ sessionKey, message, idempotencyKey }`    | `{ runId?, accepted }`   |
| `chat.abort`              | `{ sessionKey, runId? }`                     | `{ aborted }`            |
| `exec.approval.resolve`   | `{ id, decision: 'allow' \| 'deny' }`        | `{ resolved }`           |
| `sessions.list`           | `{ kind? }`                                  | `{ sessions: GatewaySession[] }` |

`idempotencyKey`는 `crypto.randomUUID()` — Gateway가 재전송 중복을 식별한다. RPC 타임아웃 10s.

## 이벤트

| Event                       | 언제                                                  | Payload 핵심 필드 |
|-----------------------------|-------------------------------------------------------|--------------------|
| `connect.challenge`         | 연결 직후 (handshake)                                 | `nonce`, `expiresAt?` |
| `chat` (state=`delta`)      | 응답 스트리밍 증분                                    | `runId`, `sessionKey`, `delta` |
| `chat` (state=`final`)      | 턴 완료                                               | `response`, `tools`, `inputTokens`, `outputTokens`, `modelId` |
| `chat` (state=`aborted`)    | `chat.abort` 처리됨                                   | `runId` |
| `chat` (state=`error`)      | 생성 실패                                             | `error` |
| `exec.approval.requested`   | 툴 실행 승인 요청 (Bash, Write 등)                    | `id`, `tool`, `command?`, `reason?`, `options?` |
| `exec.approval.resolved`    | 승인 결정 반영                                        | `id`, `decision` |
| `presence`                  | 형제 클라이언트 연결 상태                             | `connected`, `clientId?` |
| `tick`                      | 서버 heartbeat (~매 초)                               | `serverTime` |
| `shutdown`                  | Gateway 정상 종료 알림                                | `reason?`, `restartAt?` |

### chat 이벤트 해석 주의

- `delta`는 텍스트 조각뿐 아니라 `tools` 배열도 포함할 수 있다 (tool 호출이 스트리밍 중 추가될 때).
- `final`의 `response`는 전체 누적 텍스트. 클라이언트는 `delta`를 직접 누적하지 말고 `final.response`를 정답으로 사용하는 것을 권장.
- `newSessionId`가 등장하면 Gateway가 새 세션을 생성한 것. 클라이언트는 `currentSessionKey`를 갱신해야 한다.

## 세션 추적

- `sessions.list` 초기 결과로 활성 세션 카탈로그 수신 → `currentSessionKey`를 선택.
- `chat` 이벤트에 포함된 `sessionKey`/`runId`로 갱신.
- 세션 종료는 명시적 이벤트가 없으며 Gateway 재시작 시 `connect.challenge`부터 다시.

## 재연결 & 에러

- WebSocket 끊기면 exponential backoff (1s → 2s → … → max 30s) 후 자동 재연결.
- 재연결 시 `connect.challenge`가 새로운 `nonce`로 다시 온다. 서명 재생성 필수.
- `seq`/`stateVersion` 필드는 Gateway 측 이벤트 리플레이 지원을 위한 장래 확장 자리표시자 — 현재 Node/Swift 구현은 활용하지 않는다.

## 프로토콜 버전 관리

- 현재 메이저 버전: `GATEWAY_PROTOCOL_VERSION = 3`.
- 필드 추가는 optional로 도입 → 기존 클라이언트 호환. 필드 삭제/시맨틱 변경은 메이저 버전 증가 필요.
- 버전 증가 시:
  1. `shared/src/gateway-protocol.ts`에서 상수 수정
  2. `pnpm generate-protocol` 실행 (CI drift 검사가 generated/ 강제)
  3. Node/Swift 어댑터에서 handshake 시 버전 확인 로직 추가
  4. `docs/gateway-protocol.md` (이 문서) 변경사항 기록

## 참고 구현

| 역할 | Node (TypeScript)                         | Swift                                                           |
|------|-------------------------------------------|-----------------------------------------------------------------|
| 어댑터 | `bridge/src/adapters/openclaw.ts`         | `apple/AgentDeck/Daemon/Gateway/OpenClawAdapter.swift`          |
| 프레임 파싱 | `handleGatewayMessage()` (id 기반 디스패치) | 동일                                                            |
| Ed25519 | Node `crypto.sign(null, ...)` (raw EdDSA) | `CryptoKit.Curve25519.Signing.PrivateKey.signature(for:)`       |
| 재연결 | `scheduleReconnect()` with jittered backoff | `DaemonService`가 `NWPathMonitor` wake 시 자체 재연결 트리거    |

Parity 테스트 fixtures는 `tests/parity/gateway-frames/*.json` (Phase 4-B 작업).
