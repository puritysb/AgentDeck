# 2026-03-31 — Swift Pixoo 렌더러를 임시 HUD에서 Terrarium 파이프라인으로 교체

### 문제
Swift daemon의 Pixoo는 HTTP 전송 자체는 되기 시작했지만, CLI daemon과 전혀 다른 단순 텍스트 HUD를 그리고 있었다. 그래서 Pixoo 장치에는 "뭔가 뜨지만 완전히 엉뚱한 화면"이 나왔다.

### 원인
`apple/AgentDeck/Daemon/Modules/PixooRenderer.swift`가 `bridge/src/pixoo/pixoo-renderer.ts` parity가 아니라, 초기 bring-up용 64x64 텍스트 HUD였다. 또한 `PixooModule`은 이벤트가 올 때만 프레임을 한 번 만들고, 이후 push loop는 그 정지 프레임만 반복 전송했다.

### 해결
- `PixooRenderer.swift`: 기존 텍스트 HUD 삭제
- `PixooRenderer.swift`: macOS Dashboard와 같은 `TerrariumRenderer`를 off-screen `ImageRenderer`로 64x64 RGB 프레임으로 렌더
- `PixooModule.swift`: 이벤트는 캐시만 갱신하고, 실제 Pixoo push 시점마다 현재 상태로 프레임 재렌더
- `PixooModule.swift`: `DashboardState`를 캐시된 `state_update` / `usage_update` / `sessions_list`에서 재구성해 Terrarium 상태 매핑에 사용

### 현재 상태
- Pixoo는 더 이상 임시 텍스트 화면을 그리지 않고, Dashboard terrarium 기반 장면을 전송한다
- Pixoo HTTP transport(custom channel / PicID sync / connection-close per request)와 렌더링 경로가 모두 교체됐다
- CLI `pixoo-renderer.ts`와 1:1 완전 동일 포트는 아니지만, "임시 HUD" 단계는 제거됨
