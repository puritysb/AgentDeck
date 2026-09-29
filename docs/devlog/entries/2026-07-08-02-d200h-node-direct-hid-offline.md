# 2026-07-08 — D200H Node direct-HID 삭제 + OFFLINE 브랜드 마크 통일

### 문제
1. **D200H "미연결" 오표시**: Ulanzi Studio 플러그인으로 연동 중인데 `/devices`·`agentdeck devices`가 direct-HID 연결 여부만 봐서 계속 미연결로 나옴.
2. **direct-HID dead code**: Node direct-HID(`d200h-module.ts` + `bridge/src/d200h/`)는 데몬이 이미 `d200h: false`로 게이팅해 런타임에 아무 데서도 start 안 됨(dormant "재활성 가능"으로 문서화돼 있었으나 실질 dead). 사용자 요청으로 제거.
3. **OFFLINE 이미지 결 불일치**: D200H·StreamDeck·StreamDeck+ 의 오프라인 화면이 초록 play 글리프/파랑 pulse/Arial "Offline" 텍스트라, AgentDeck 돔+데크 브랜드 마크를 쓰는 다른 표면(macOS/iOS/Android 오버레이, ESP32 splash)과 튐.

### 해결
- **연결성 fix**: `WsServer.getUlanziClientCount()` 추가, `/devices`·module-health·CLI 가 `ulanzi-plugin` WS presence 로 D200H connected 판정.
- **Node direct-HID 삭제**: `bridge/src/modules/d200h-module.ts`, `bridge/src/d200h/{hid-protocol,image-renderer}.ts`, `d200h-button-map.test.ts` 제거. 잔여 dead 배관 정리(`/devices` d200hModule 조회+writeOK/writeFail, cli 도달불가 else 분기, `ModuleConfigs.d200h` 플래그, stale 주석). **Swift `D200hHidModule.swift` 는 그대로 dormant 보존**. `shared/src/d200h-layout.ts`(레이아웃 엔진, plugin-ulanzi+TUI 의존)는 유지.
- **OFFLINE 브랜드 마크 SSOT**: `AgentDeckLogo.swift`(0–24 유닛)를 SVG로 포팅한 `renderAgentDeckMark()` 신설(`shared/src/svg-renderers/session-slot-renderer.ts`), `'agentdeck'` 글리프가 delegate, 아쿠아리움 시안-on-잉크 `'brand'` 톤 추가. 3표면 오프라인 전부 라우팅(SD `renderDisconnectedSlot`/`renderOpenApp*`, SD+ `renderOfflineTouchStrip`+plugin `response`/`voice` 타일, D200H `buildSessionDeck` hero+레거시 `renderOfflineSlot`). resvg 렌더 육안 검증 완료, 스냅샷 7개 갱신.

### 핵심 설계 결정
- **삭제 vs dormant 보존**: 문서는 Node direct-HID 를 "flip 하나로 재활성 가능한 dormant"로 규정했으나, 런타임 dead + 사용자 명시 삭제 요청 → 삭제하고 재활성 경로를 "git history 복원"으로 문서 갱신. Swift 쪽은 미변경(별도 flip-point 유지).
- **오프라인 결 = 브랜드 마크**: 다수 표면(Apple/Android/ESP32)이 이미 돔+데크 마크. shared 에 AgentDeck SVG 가 아예 없던 걸 신설해 SSOT 화 → 표면별 재구현 없이 한 곳 수정으로 통일.
