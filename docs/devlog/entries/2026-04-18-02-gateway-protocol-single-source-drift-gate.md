# 2026-04-18 — Gateway Protocol Single-Source & Drift Gate

### 문제
OpenClaw Gateway 와이어 포맷(프레임 envelope, Ed25519 핸드셰이크, RPC 메소드, 이벤트 카탈로그)이 세 곳에 **독립 선언**되어 있었다:
- `bridge/src/adapters/openclaw.ts` — Node 어댑터 내부 `interface GatewayRequest / GatewayResponse / GatewayEventFrame / GatewaySession`
- `apple/AgentDeck/Daemon/Gateway/OpenClawAdapter.swift` — Swift 포팅
- `docs/` — 문서화되지 않음 (openclaw.ts 주석 43~67줄만 존재)

새 필드/메소드를 추가할 때 Node/Swift 둘 다 수동으로 맞춰야 했고, parity 검증 수단이 없어 silent drift 위험. App Store 제출을 앞둔 구조 점검의 일환으로 single-source 로 수렴.

### 해결
1. **Shared single source 생성** — `shared/src/gateway-protocol.ts` 신규. `GatewayFrame`, 5개 메소드(`connect` / `chat.send` / `chat.abort` / `exec.approval.resolve` / `sessions.list`), 7개 이벤트(`connect.challenge` / `chat` / `exec.approval.*` / `presence` / `tick` / `shutdown`)의 타입·payload 스키마를 선언. `ED25519_SPKI_PREFIX_LEN`, `GATEWAY_PROTOCOL_VERSION`, `GATEWAY_DEFAULT_PORT` 상수도 이동.
2. **코드젠 확장** — `scripts/generate-protocol.sh` 에 GatewayFrame Swift/Kotlin 생성 스텝 3개 추가. `generated/protocol/GatewayFrame.{swift,kt,json}` 산출. `.gitignore` 의 `generated/` 를 `generated/*` + `!generated/protocol/` 로 바꿔 드리프트 게이트를 track 가능.
3. **CI 드리프트 게이트** — `.github/workflows/ci.yml` 에 "Protocol drift check" 스텝 추가. PR 에서 `pnpm generate-protocol` 실행 후 `git diff --quiet generated/protocol/` 위반 시 실패. 한 번 baseline 이 커밋되면 TS 쪽 Gateway 타입을 바꾸면서 generated/ 를 같이 커밋 안 하면 CI 실패.
4. **Node 어댑터 수렴** — `bridge/src/adapters/openclaw.ts` 에서 로컬 interface 5개 제거, `@agentdeck/shared` import 로 전환. `bridge/src/types.ts` 에 Gateway 타입 re-export 추가. `rpcCall` 의 message 객체는 `as const` 리터럴로 유니온 좁히기 회피 (loose 유지 — 다음 단계에서 method/params union 으로 엄격화 예정).
5. **스펙 문서** — `docs/gateway-protocol.md` 신규. 프레임 포맷 다이어그램, Ed25519 서명 payload 조립(`v2|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce`), 메소드·이벤트 표, 재연결/버전 규칙.
6. **Parity fixtures 1차** — `tests/parity/gateway-frames/*.json` 7종(connect-challenge/ok, chat-delta/final, exec-approval-requested, rpc-error, tick) + README. `bridge/src/__tests__/gateway-parity-fixtures.test.ts` 17건으로 frame discriminator 와 shape 계약 검증. Swift 쪽 `GatewayParityTests.swift` 추가는 별도 세션.
7. **mDNS 복구 단축** — `bridge/src/mdns.ts` `MDNS_RECOVERY_INTERVAL` 30s → 5s. WiFi 전환/wake 복귀 시 클라이언트 discovery 지연 창을 6배 축소.
8. **Swift 어댑터 degradation UX** — `OpenClawAdapter.swift` `loadDeviceIdentity()` catch 블록을 샌드박스/not-paired/기타 에러로 분기해 info 레벨로 구체적 안내 로그. SettingsScreen 의 sandboxed 배너와 쌍을 이룸. (이 파일은 본 세션 커밋에서 제외 — 별개 OpenClaw model catalog 수정이 섞여 있어 사용자 마무리 후 별도 커밋 예정.)

### 핵심 설계 결정
- **점진적 수렴, 전면 통합 아님**: Node daemon 과 Swift daemon 은 각자 유지. 프로토콜 타입만 shared 로 single-source, 구현체(런타임/전송)는 플랫폼별 네이티브 최적화. 이유: macOS 는 App Store 샌드박스 준수 위해 Swift in-process daemon 필수, Linux/dev 는 Node CLI 필수 — 두 런타임을 합치면 배포 제약 충돌.
- **generated/protocol/ 를 track**: CI drift gate 는 track 된 baseline 이 있어야 비교 대상이 생김. `generated/` 전체를 ignore 했던 정책을 protocol 하위만 예외로 완화. baseline 첫 커밋(`bash scripts/generate-protocol.sh && git add generated/protocol && git commit`) 은 다음 세션에서 수행.
- **rpcCall 엄격화는 다음 단계**: 지금은 method 가 `string`, params 가 `Record<string, unknown>` 로 loose. GatewayMethodName/GatewayMethodParams union 으로 좁히면 `events.history` 같은 스펙 외 호출이 걸리는데, 그 메소드의 shared 선언 추가 또는 deprecation 여부 판단이 선행. 엄격화는 다음 PR.
- **Apple Swift OpenClawAdapter 는 이 커밋에서 제외**: 사용자가 model catalog 파싱(`missing` 필드, default key→name) 을 별도로 수정 중. 내 degradation 로그 diff 와 섞지 않고 분리 커밋 예정.

### 후속
- `generated/protocol/` baseline 커밋 → CI drift gate 활성화
- Swift `apple/AgentDeckTests/GatewayParityTests.swift` — 동일 fixture JSON 을 `JSONDecoder` 로 decode 해 Node 와 동일 invariants 검증
- Swift `OpenClawAdapter.swift` 를 `generated/protocol/GatewayFrame.swift` 로 전환해 양쪽 단일 소스 완성
- `rpcCall` 타입 엄격화 + `events.history` 스펙 편입 또는 제거
- Phase 3 (Device Transport 추상화) 별도 플랜

---
