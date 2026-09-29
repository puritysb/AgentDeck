# 2026-03-22 — OpenClaw Gateway 이중 연결 정리 (Plugin→Daemon 단일 경로)

### 문제
Plugin이 OpenClaw Gateway(port 18789)에 **독립적으로** WS 연결을 유지하고 있었음 — daemon과 별개로 Ed25519 인증, `openclaw logs --follow --json` subprocess, timeline enrichment를 모두 중복 수행. Gateway 관점에서 동일 device의 WS 연결 2개 + log subprocess 2개 = 리소스 낭비 + 상태 혼란(불안정성 원인 추정).

### 해결
Plugin의 직접 Gateway 연결을 완전 제거, daemon 경유 단일 경로로 전환:
- `plugin/src/gateway-client.ts` (1200줄), `log-stream.ts`, `timeline-summarizer.ts` 삭제 (순 -2288줄)
- `ConnectionManager` 재작성: `GatewayClient`/`activeLink` 이중 링크 → `BridgeClient` 단일 연결
- `switch_agent` WS 커맨드 추가 (`shared/protocol.ts` + `daemon-server.ts`) — 에이전트 전환을 daemon에 위임
- Session button의 `activateGateway()`/`activateBridge()` → `switchToOpenClaw()`/`switchToClaude()`

### 교훈 / 핵심 설계 결정
- **Gateway 연결은 daemon 단독** — Android/Apple/TUI/ESP32 모두 이미 daemon 경유. Plugin만 이중 연결이었음
- `receivingBridgeTimeline` 플래그로 이벤트만 억제해도 WS 연결 자체는 유지되어 Gateway에 부하. 근본 해결은 연결 자체 제거
- Daemon이 이미 `onCommand` 핸들러에서 Plugin WS 커맨드를 `OpenClawAdapter.handleCommand()`에 라우팅하고 있었으므로, 새 인프라 추가 없이 `switch_agent` 커맨드만 추가하여 해결

---
