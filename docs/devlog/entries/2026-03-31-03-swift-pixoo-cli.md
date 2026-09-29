# 2026-03-31 — Swift Pixoo 렌더러를 CLI 규칙에 더 가깝게 정렬

### 문제
Swift Pixoo는 전송은 되더라도 기존 CLI daemon의 Pixoo 화면과 같은 규칙을 따르지 않았다. 특히 Swift 전용 보조 오버레이(세션 점, 단순 막대 HUD)와 event-triggered stale frame 전송 때문에 “무언가 뜨지만 완전히 다른 화면”처럼 보일 수 있었다.

### 해결
- `PixooModule.swift`: 이벤트 때 즉시 프레임을 굽는 대신, push tick마다 현재 `DashboardState`를 재구성해 매번 새 프레임을 렌더하도록 변경
- `PixooRenderer.swift`: 임시 텍스트 HUD/세션 점 오버레이 제거
- `PixooRenderer.swift`: Swift terrarium off-screen 렌더링을 공통 베이스로 유지하되, Pixoo camera cycle(overview/left/right/active tracking)과 usage HUD를 Node Pixoo 쪽 규칙에 맞게 보강
- `PixooRenderer.swift`: Node `pixoo-sprites.ts`의 3x5 픽셀 폰트를 Swift로 포팅해 하단 usage percent/reset HUD를 right-aligned bitmap text로 표시
- `PixooRenderer.swift`: high-usage danger flash를 추가해 90%+ 구간에서 Node Pixoo와 유사한 붉은 경고 펄스를 화면 전체에 입힘

### 검증
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataPixooHud build CODE_SIGNING_ALLOWED=NO`
- 결과: `BUILD SUCCEEDED`

### 후속 정렬 (같은 날)
- `PixooRenderer.swift`를 더 이상 Swift terrarium 캡처 기반으로 두지 않고, `bridge/src/pixoo/pixoo-renderer.ts` / `pixoo-camera.ts` / `pixoo-sprites.ts` 구조를 따르는 direct 64×64 pixel renderer로 재작성
- water/terrain/seaweed/light-ray/caustics/bubble/data-particle/tetra-school/camera-director/crayfish-HUD 경로를 Swift 안에 직접 포팅
- 활성 크리처 카메라 타게팅 순서를 `Dictionary` 임의 순서가 아니라 `creatureOrder` 기반의 stable insertion order로 정렬해 Node `Map` 순서와 더 가깝게 맞춤
- primary 세션 상태를 현재 `DashboardState`로 다시 덮어써 daemon/sibling poll stale 상태 때문에 Pixoo가 늦게 반응하는 문제를 완화

### 추가 검증
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataPixooPort3 build CODE_SIGNING_ALLOWED=NO`
- 결과: `BUILD SUCCEEDED`
