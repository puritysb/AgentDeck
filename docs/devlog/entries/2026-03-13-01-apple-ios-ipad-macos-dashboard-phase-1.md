# 2026-03-13 — Apple (iOS/iPad/macOS) Dashboard 앱 Phase 1

### 작업
Android 태블릿/e-ink 대시보드 완성 후 Apple 플랫폼 확장. SwiftUI Multiplatform (iOS 17.0 / macOS 14.0) 단일 프로젝트로 iPhone, iPad, Mac 동시 지원.

### 구현 (Phase 1: Protocol + Networking)
- `apple/` 디렉토리 생성, 22 Swift 파일, `swiftc -typecheck` 전체 통과
- **Model**: `shared/src/*.ts` → Swift Codable structs 포팅 (13 BridgeEvent 타입, 11 PluginCommand)
- **Net**: `URLSessionWebSocketTask` + exponential backoff (1s→8s), `NWBrowser` mDNS, JSON type discriminator
- **State**: `@Observable` AgentStateHolder (null-coalescing update 패턴 — Android 동일), TimelineStore (groupConsecutive)
- **UI**: 3-tab 구조 (Dashboard/Deck/Settings), ConnectionOverlay, 기본 HUD, DeckButton/EncoderStrip
- **Tests**: ProtocolTests (12), TimelineTests (9)
- `project.yml` (xcodegen) → Xcode 프로젝트 자동 생성

### 핵심 설계 결정
- **xcodegen 사용**: `.xcodeproj` 수동 관리 대신 `project.yml` 선언형 → `xcodegen generate`
- **iOS + macOS 분리 타겟**: `platform: [iOS, macOS]` 합체 타겟은 test dependency 이슈 → `AgentDeck_iOS` + `AgentDeck_macOS` 분리
- **Swift 6 호환**: `@Observable` + `@unchecked Sendable` 패턴, `AnyCodable`은 `@unchecked Sendable`
- **NWTXTRecord API**: `.keyValue` entry 패턴 매칭은 Swift 6에서 변경 → `.string` + key=value 파싱
- **Bundle ID**: `dev.agentdeck.dashboard`

### 남은 작업
Phase 2 (Terrarium 60fps) → Phase 3 (HUD) → Phase 4 (Deck) → Phase 5 (Voice/QR) → Phase 6 (App Store)

---
