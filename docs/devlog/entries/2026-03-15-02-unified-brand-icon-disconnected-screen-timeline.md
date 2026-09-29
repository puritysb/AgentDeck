# 2026-03-15 — Unified Brand Icon + Disconnected Screen + Timeline 수정

### 문제
1. **브랜드 일관성 부재**: 각 플랫폼(Android/Apple/ESP32) disconnected 화면이 제각각 — 아이콘, 카드 레이아웃, 버튼 스타일 불일치
2. **앱 아이콘 미설정**: Apple AppIcon 슬롯 전체 비어있음, Android는 기본 벡터 XML
3. **Apple Timeline 미표시**: SwiftUI `@Observable` 중첩 객체 관찰 문제 — `TimelineStore`(nested @Observable) 변경이 UI에 전파 안 됨
4. **OpenClaw 중복 표시**: Daemon이 `agentType=openclaw`로 primary 전송 + virtual `openclaw-gateway` sibling 주입 → #1, #2 중복
5. **Apple reconnecting 버튼 깜빡임**: `connectInternal()`이 매 reconnect마다 `disconnect(reconnect: false)` 호출 → `isReconnecting=false` 리셋
6. **Apple은 bridge timeline 이벤트에만 의존**: Daemon IDLE시 timeline_event 미전송 → Android(StateTimelineGenerator 로컬 생성)만 timeline 보임

### 해결

**브랜드 통일**:
- `~/Desktop/agentdeck-icon.png` (640×640 3D 테라리움) → Android drawable + Apple imageset + ESP32 LVGL canvas
- Android tablet: 80dp icon + card layout (기존 유지, icon 추가)
- Android e-ink: 48dp grayscale icon (`setToSaturation(0f)`)
- Apple: ZStack scrim + centered card (360pt, rounded 16) — `.secondary` → 명시적 `slateText` (#94A3B8)
- ESP32: LVGL canvas 48×48 (jar + octopus silhouette 프리미티브 드로잉) — 사용자가 "{ }" 텍스트 아이콘으로 변경

**앱 런처 아이콘**:
- Apple: `sips` 리사이즈 7개 PNG (16~1024) → AppIcon.appiconset 11슬롯 매핑
- Android: 5개 mipmap density (mdpi 48px ~ xxxhdpi 192px), adaptive icon XML 제거 → PNG 직접

**Timeline 수정 (3단계 디버깅)**:
- 1차: `@State grouped` + `onChange(of: entries.count)` → 중첩 Observable 미전파
- 2차: `timelineVersion` counter + `onChange` → body에서 안 읽혀 observation 미등록
- 최종: `timelineVersion` computed property + `.id(timelineVersion)` — body에서 반드시 읽히는 `.id()` 메커니즘으로 observation 강제 등록
- **근본 해결**: `StateTimelineGenerator.swift` 추가 — Android와 동일하게 state 전환에서 로컬 timeline 생성, bridge rich timeline 수신 시 억제

**OpenClaw 중복 수정**:
- Apple SessionListPanel + Android 3곳 (SessionListPanel, EinkAgentColumn, EinkPortraitHeader)
- 로직: sibling.agentType == primary agentType이고 이미 entries에 존재하면 skip

**Reconnecting 깜빡임 수정**:
- Apple `connectInternal()`: `disconnect(reconnect: false)` 대신 소켓만 직접 정리, `isReconnecting`/`reconnectAttempt` 보존
- Android는 reconnect 경로에서 `doConnect()` 직접 호출 (disconnect 미경유) → 문제 없었음

**iOS 화면 회전**:
- `UIDevice.setValue` (deprecated, 미동작) → `UIWindowScene.requestGeometryUpdate()` (iOS 16+)
- 아이콘: `arrow.triangle.2.circlepath` → `rectangle.portrait.rotate`, 투명도 0.6→0.35

### 교훈 / 핵심 설계 결정
- **SwiftUI @Observable 중첩 객체**: nested @Observable의 프로퍼티 변경은 부모의 body에서 추적 안 됨. 부모에 version counter 두고 `.id()` modifier로 강제 observation 등록이 가장 확실
- **Timeline은 로컬 생성 필수**: Bridge가 timeline을 항상 보내는 것은 아님 (IDLE, 특정 adapter 미지원 등). 각 클라이언트가 state 변화에서 로컬 timeline을 생성하되, bridge rich timeline 수신 시 억제하는 2-tier 패턴
- **Daemon primary agentType 치환**: Daemon이 Gateway 연결 시 primary를 `openclaw`로 보내면서 virtual sibling도 주입 → 모든 세션 리스트 UI에서 중복 방지 로직 필요
- **Reconnect 상태 보존**: reconnect 시도 시 이전 연결을 정리할 때 reconnecting 상태 플래그를 리셋하면 안 됨 — Android 패턴(소켓만 정리, 상태 유지) 따를 것

---
