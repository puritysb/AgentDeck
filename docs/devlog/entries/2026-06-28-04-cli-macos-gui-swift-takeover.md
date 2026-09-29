# 2026-06-28 — CLI 데몬 ↔ macOS GUI 앱(Swift) 경합 방지 및 포트 Takeover

### 문제
macOS GUI 앱(Swift 인프로세스 데몬)이 먼저 `9120` 포트를 선점하고 동작할 때, 터미널에서 CLI 데몬(`agentdeck daemon start`)을 띄우면 이미 포트가 점유 중임을 감지하여 CLI 데몬이 즉시 종료(`process.exit(0)`)되었다. 이로 인해 Claude Code/Codex 등 터미널 세션을 띄우는 데 필수적인 PTY 스폰 전용 CLI 데몬 허브를 함께 띄울 수 없어 두 프로그램 간에 경합과 동작 차단이 발생했다.

### 해결
1. **Swift Daemon `/health` 응답 보완**: `DaemonServer.swift`의 `/health` 응답 JSON에 `"isSwift": true` 플래그를 실어, 해당 데몬이 macOS 앱의 인프로세스 데몬임을 구별할 수 있게 함.
2. **Swift 앱 자동 양보 및 클라이언트 전환**:
   - `DaemonServer.swift`에 `onShutdown` 콜백을 등록.
   - `DaemonService.swift`에서 `onShutdown` 콜백 수신 시 `connectToExternalDaemon`을 바로 실행하여, 로컬 HTTP/WS 소켓을 닫고 외부 CLI 데몬의 중계 클라이언트 모드(`isUsingExternalDaemon = true`)로 실시간 복귀하도록 조치.
3. **CLI 데몬 Takeover 메커니즘**:
   - `session-registry.ts`에 타 데몬 종료 유도 API인 `requestDaemonShutdown(port)` 추가.
   - `daemon-server.ts`의 싱글톤 가드 로직에서 `/health` 프로브 시 `isSwift === true`가 발견되면, 해당 데몬에게 `requestDaemonShutdown`을 쏘고 **1.5초**간 소켓 릴리즈를 대기한 뒤 `process.exit(0)` 없이 포트를 이어받아 기동하게 함.

### 핵심 설계 결정
- **소유자(Port Owner)의 양보와 백엔드 보존**: GUI 앱이 포트 `9120`을 반납(수신 소켓 Close)하고 외부 데몬의 클라이언트로 붙어도, 앱 프로세스는 유지되므로 **D200H USB HID(Stream Deck+) 통신 등의 샌드박스 내 기기 제어는 온전히 살아남아** 외부 CLI 데몬으로 데이터가 정상 릴레이됨.
- **100% 완전체 하이브리드 구동**: 샌드박스 외부 CLI의 PTY 기동 권한과 샌드박스 내부 앱의 USB 독점 권한이 경합 없이 한 쌍으로 엮이는 구조를 실현.
- **검증**: `pnpm test`로 `vitest` 유닛 테스트 1556개 전원 통과 확인.
