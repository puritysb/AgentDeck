# 2026-04-18 — Gateway Protocol Single-Source (Follow-up: Activation)

### 문제
직전 같은 날짜 세션(커밋 990d3b52, e1cea599)에서 Gateway 와이어 포맷을
`shared/src/gateway-protocol.ts` 로 single-source 하고 CI 드리프트 게이트와
parity fixtures 를 추가했지만, 네 가지가 미완으로 남아 있었다.
1. `generated/protocol/` baseline 이 아직 커밋되지 않아 CI "Protocol drift
   check" 스텝이 비교 대상 없이 실질적 무효.
2. Swift 쪽 parity test (`apple/AgentDeckTests/GatewayParityTests.swift`) 부재.
3. Swift `OpenClawAdapter.swift` 가 여전히 로컬 `[String: Any]` 파싱만 하고
   생성 타입(`generated/protocol/GatewayFrame.swift`) 을 실제로 쓰지 않음.
4. Node `rpcCall(method: string, params: Record<string, unknown>)` 시그니처가
   method/params 상관관계를 강제하지 않아 `events.history` 같은 spec 외 호출이
   통과됨.

### 해결
**1457f32d — Baseline `generated/protocol/` 커밋** (11 files, +7361)
- `pnpm build && bash scripts/generate-protocol.sh` 후 `git add generated/protocol`.
- 이제 PR 에서 `shared/src/*` 를 변경하고 regen 을 잊으면 CI 가 red.

**b1dbb3c7 — Swift parity tests + OpenClawAdapter 전환**
- `apple/AgentDeckTests/GatewayParityTests.swift` 신설 — Node
  `gateway-parity-fixtures.test.ts` 를 1:1 미러. `#filePath` 로 repo-root
  경유해 `tests/parity/gateway-frames/*.json` 접근. `xcodebuild test-only` 로
  6 tests pass in 0.008s.
- `apple/project.yml` + pbxproj: `../generated/protocol/GatewayFrame.swift`
  를 `AgentDeck_macOS` 타겟 sources 에 추가 (iOS 는 OpenClaw adapter 미탑재).
- `OpenClawAdapter.swift` `handleMessage(_:)`: `JSONDecoder().decode(ADGatewayFrame.self, ...)`
  로 envelope 디코드 → `ADType` (`.req/.res/.event`) + `ADGatewayEventName`
  (`.connectChallenge/.chat/.execApprovalRequested/...`) enum 으로 switch.
  Exhaustive — shared spec 에 event 추가 시 여기서 컴파일 실패.
- Payload field access 는 여전히 `[String: Any]`. quicktype 의 `ADGateway`
  payload struct 가 모든 이벤트 필드를 flat optional 로 합쳐 놓아 typed 접근이
  이득이 없다. 실제 parity 강제 포인트는 discriminator 레벨이면 충분.
- `scripts/generate-protocol.sh`:
  - GatewayFrame 쪽 `--protocol equatable` 제거 — `ADGatewayError.details`,
    `ADChatToolInvocation.input/output` 이 `JSONAny?` 이라 Equatable synthesis
    실패 → Swift 6 strict mode 가 전체 타겟을 reject.
  - `sed -i '' -e 's/^class JSONCodingKey:/final class JSONCodingKey:/'` 후처리 —
    Swift 6 는 non-final Sendable class 거부.
- 병행 작업으로 working tree 에 남아 있던 두 변경을 함께 커밋:
  `loadDeviceIdentity()` degradation 분기 (sandbox/not-paired/other), 모델
  카탈로그 `missing` 필드 + `defaultModel` by-name fallback.

**31f2d4fe — `GatewayMethodMap` + `rpcCall` narrowing + dead code 제거**
- `shared/src/gateway-protocol.ts` 에 `GatewayMethodMap` interface 추가 —
  method name → `{ params, result }` 매핑.
- `OpenClawAdapter.rpcCall` 를
  `<M extends keyof GatewayMethodMap>(method: M, params: Map[M]['params']) => Promise<Map[M]['result']>`
  로 generic 화. method/params 불일치, spec 외 method 모두 컴파일 에러.
- `fetchHistory()` + `events.history` 참조 삭제. 메소드 정의 외 caller 가
  bridge/plugin/setup 어디에도 없던 dead code. 재등장 시 shared spec 에
  정식 편입하는 쪽으로 정책 고정.
- **`ConnectParams` wire 정합성 정정**: spec 은 `{ auth, requestScopes, clientInfo }`
  였지만 `sendConnectRequest` 가 실제 보내는 바이트는
  `{ minProtocol, maxProtocol, client, role, scopes, caps, device?, auth? }` —
  완전히 다른 shape. spec 을 wire 에 맞춤. `connect` RPC 가 `rpcCall` 을 안
  거치는 별도 경로라 기존엔 spec 거짓말이 걸러지지 않았다.
- Regen 후 `generated/protocol/GatewayFrame.{swift,kt,json}` 갱신. 드리프트
  게이트가 "DIRTY" 를 즉시 잡아낸 덕에 regen 누락 방지 확인.
- 검증: `pnpm build` 통과, `pnpm vitest run` 906/906 pass, parity 17/17 pass,
  `xcodebuild AgentDeck_macOS build` BUILD SUCCEEDED.

### 핵심 설계 결정
- **Discriminator-level parity 면 충분**: Swift 어댑터가 envelope 과 이벤트
  이름은 typed enum 으로 받고 payload 필드는 dict 로 읽는 hybrid 방식 채택.
  quicktype 의 flat 합집합 struct 로 field-level typing 을 강제해도 `JSONAny`
  때문에 실질적 안전성은 늘지 않는다. Spec drift 가 생기면 envelope/이벤트
  rename 이 먼저 잡히므로 실무상 충분.
- **`events.history` 는 remove-not-spec**: 해당 메소드가 실제로 쓰이는 시점에
  shared 에 편입하고 regen. 지금 미래 추측으로 spec 에 넣어두면 drift 표면만
  늘어난다.
- **Swift 6 + quicktype 호환 패치는 generator 에 박는다**: `--protocol equatable`
  제거와 `JSONCodingKey` final 변환을 매번 손으로 하지 않도록
  `generate-protocol.sh` 안에 고정. 차후 spec 이 바뀌어 재생성해도 동일 결과.
- **`ConnectParams` 처럼 wire 와 spec 이 어긋난 부분은 wire 쪽이 ground truth**:
  단일 소스의 가치는 spec 이 구현과 합의될 때만 성립. 이번에 즉시 정정.

### 후속
- `generated/protocol/` 크기가 커서(11 files, 7361 lines) PR diff 에 소음을
  일으킬 수 있음 — `.github/workflows/` 에 `generated/protocol/**` 패스트링 필터가
  필요한지 관찰 후 결정.
- Swift 쪽 `BridgeEvent.swift` / `PluginCommand.swift` 도 같은 방식으로
  target 편입 가능 (지금은 `AgentCommand.swift` 만 포함). 현재 native
  hand-crafted `Protocol.swift` 와 중복될 수 있어 우선순위는 낮음.
- APME `events.history` 가 필요해지면 shared spec 에 정식 추가 + regen +
  Node/Swift 양쪽 handler 구현.

---
