# 2026-06-25 — TRMNL App Store standalone hub parity + observability

### 문제
TRMNL 안정화 문서/CLI가 "Node daemon = usage-capable hub, macOS app = client" 중심으로 굳어 App Store 단독 배포 관점과 충돌했다. 실제 Swift 앱은 `/api/display`를 서비스하지만 `/health`/`/status`/`/devices`/`moduleHealth`에 `trmnl`이 빠져 있어 운영자는 패널이 붙었는지, stale인지, RSSI가 약한지 알 수 없었다. 또한 Swift TRMNL enrollment가 in-memory라 앱 재시작 뒤 상태 표면이 비어 보이고, 실행 중인 구버전 앱에서는 약한 RSSI에도 낮은 `image_url_timeout`이 나가 "not responding" 재발 가능성이 있었다.

### 해결
- **App Store Swift daemon을 first-class BYOS hub로 승격**: `TrmnlSettings`가 `trmnl.devices[]`를 Node와 같은 shape으로 읽고 저장. Auto-enroll 시 sandbox `settings.json`에 enrollment만 영속화하고, poll telemetry는 runtime-only 유지(파일 churn 없음).
- **관측성 parity**: Swift `TrmnlModule.statusSnapshot()`을 `/health`·`/status`·`/devices`·`state_update.moduleHealth`·앱 내부 `DeviceSummary`에 연결. telemetry는 MAC, 해상도, RSSI, 배터리, lastSeen/secondsSinceSeen, stale flag를 제공. 동기 broadcast 경로는 5초 캐시 사용(SerialModule 패턴).
- **계약 parity**: Swift 경로도 기본 `image_url_timeout=50s`, 약한 RSSI(≤ -78dBm)는 60s로 확장. App Store 앱 단독으로도 등록/렌더/헬스가 완결되고, CLI daemon은 개발 세션/Claude OAuth quota relay를 보강하는 progressive enhancement로 재정의.
- **화면 효율 개선**: TRMNL footer가 quota-known 일 때만 5H/7D gauge를 그린다. App Store-only/OAuth-blind 상태처럼 quota가 구조적으로 unknown이면 30px compact hub-status strip으로 접어 800×480에서 9번째 session row까지 본문에 돌려준다(Node SVG + Swift CoreGraphics parity).
- **문서/CLI 정정**: `agentdeck trmnl`, `docs/devices.md`, README, App Store feature matrix, hardware compatibility에서 "Node가 정답 hub" 문구를 "하나의 안정적 hub(App Store 앱 또는 CLI)"로 변경.

### 핵심 설계 결정
- **Daemon이 완전히 꺼진 상태는 TRMNL 펌웨어 오류 UI가 맞다.** Pull-only BYOS 특성상 응답 프로세스가 없으면 AgentDeck offline 이미지를 줄 수 없다. App Store 패키지의 목표는 "앱이 실행 중이면 standalone hub로 완결"이지, 앱 종료 후에도 별도 responder 없이 표시를 제어하는 것이 아니다.
- **영속화는 enrollment만.** 매 poll마다 telemetry를 settings에 쓰면 sandbox container 파일 churn과 UI 편집 레이스가 생긴다. stale/lastSeen은 runtime health로 충분하다.

### 검증
Green:
- `pnpm vitest run bridge/src/__tests__/trmnl-byos.test.ts bridge/src/__tests__/trmnl-renderer.test.ts shared/src/__tests__/trmnl-layout.test.ts` (42 tests)
- `pnpm --filter @agentdeck/bridge typecheck`
- `xcodebuild test -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -destination 'platform=macOS' -only-testing:AgentDeckTests_macOS/TrmnlModuleTests -only-testing:AgentDeckTests_macOS/SessionLauncherTests`
- `xcodebuild build -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -destination 'platform=macOS'`

---
