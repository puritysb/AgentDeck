# 2026-03-15 — Apple Monitor UI 2차 보정 + 멀티디바이스 상태 동기화

### 문제
1. Apple/Android Monitor UI 시각 차이: WaterEffect caustic 강도, Timeline 65/35 비율, TankStatus 줄간격, nil agentType 아이콘, macOS 버튼 테두리
2. Apple 기기에서 OpenClaw 상태 변화 미반영 (terrarium 업데이트 안 됨)
3. Apple 기기에서 bridge 단절 시 disconnect 상태 미표시
4. 멀티디바이스 간 상태 불일치 — Apple/ESP32가 session bridge(10초 폴링)에 연결되어 daemon(실시간) 대비 지연

### 해결
**시각 보정**:
- SwiftUI `plusLighter` blend mode는 Android `BlendMode.Plus`보다 ~20배 강함 → caustic alpha `0.85→0.04`, lineCount `8→5`, strokeWidth 절반
- Timeline GeometryReader 감싸서 65/35 명시적 비율 적용
- Android TankStatus `includeFontPadding=false` + spacing 4dp, Apple도 spacing 4pt 통일
- nil agentType: Apple `🐙→●` (Android 일치), macOS `.buttonStyle(.plain)`, iOS 회전 버튼 추가

**상태 동기화**:
- Apple terrarium: `.onChange(of: siblingSessions.count)` → content-based `siblingStatesKey` 추가 (내부 state 변경 감지)
- Apple disconnect: `BridgeConnection.onDisconnect` 콜백 추가 → `resetToDisconnected()` 호출
- **Daemon-preference discovery**: 3 플랫폼 모두 mDNS auto-connect 시 `agentType == "daemon"` 우선 선택
  - Apple: `discovery.bridges.first(where: { $0.agentType == "daemon" })`
  - Android: `BridgeDiscovery.kt`에 `agentType` 필드 추가 + `agent` TXT 파싱, `firstOrNull { it.agentType == "daemon" }`
  - ESP32: 2-pass scan — daemon TXT 먼저 검색, 없으면 첫 번째 사용

### 교훈 / 핵심 설계 결정
- SwiftUI와 Android의 blend mode 강도 차이가 매우 큼 — alpha 값을 플랫폼별로 독립 튜닝해야
- `@Observable` `.onChange(of: collection.count)`는 요소 내부 변경 미감지 — content-based key 필요
- WebSocket `receive` failure가 유일한 disconnect 감지 경로 — 별도 `onDisconnect` 콜백으로 UI 즉시 반영
- **mDNS 서비스 선택이 상태 일관성의 핵심**: session bridge는 sibling 10초 폴링이라 OpenClaw 상태 변화가 최대 10초 지연. Daemon은 모든 세션을 직접 관리하므로 실시간

---
