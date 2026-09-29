# 2026-06-22 — TRMNL e-ink BYOS: device-agnostic Node + App Store Swift 포팅

### 문제
TRMNL(WiFi e-ink BYOS 패널)은 (1) Node 브리지 전용이라 **App Store Swift 데몬에선 아예 동작 안 함**, (2) 해상도를 **800×480으로 하드코딩**하고 device가 보내는 `Width`/`Height` 등 BYOS telemetry 헤더를 전부 무시 → 다른 모델/해상도 패널이 붙으면 잘못된 크기 이미지를 받음, (3) `normalizeMac`이 12-hex 아닌 ID를 raw로 돌려줘 MAC 표기가 달라지면 orphan/중복 enrollment.

### 해결
- **Node device-agnostic** (`bridge/src/trmnl/`, `shared/src/trmnl-layout.ts`): `renderTrmnlDashboard`를 해상도 가변(행수=`floor((H-header-footer)/rowH)`, 컬럼·게이지 W 비례, 극단 화면비 compact 가드)으로. 단일 글로벌 프레임 → **`WxH` 키 프레임캐시(LRU 8)**, image URL이 `<W>x<H>-<hash>.png` 운반. `normalizeMac` 결정적 정규화 + `sameMac`. telemetry 헤더 런타임 맵(`trmnl-telemetry.ts`). `special_function` 추가. idle hero(합성 phantom row 제거). 28 테스트 green.
- **App Store Swift 포팅** (`apple/.../Trmnl{Module,ImageRenderer,Settings}.swift` + `DaemonServer.swift`): TS SVG/resvg는 이식 불가 → **CoreGraphics + CoreText로 대시보드 직접 그리고 1-bit grayscale PNG를 Foundation zlib로 인코딩**(D200H 렌더러 패턴). `TrmnlModule`은 actor, MAC 무관 auto-enroll + 해상도별 캐시 + in-memory enrollment/telemetry. 전송은 기존 `HTTPServer`(`/api/setup`·`/api/display`·`/api/log`·`/trmnl/image/*`). `xcodebuild AgentDeck_macOS` BUILD SUCCEEDED, 바이너리 forbidden-subprocess 0.
- **부수 수정**: direct-HID 폐기 커밋(`6d298427`)이 `let d200hRef = d200h`를 비활성 블록 안 var로 깨뜨려 **커밋된 HEAD의 macOS 타깃이 컴파일 불가**였음 → `self.d200hModule`(옵셔널, nil) + `?.handleBroadcast`로 복구.
- **문서**: `appstore-feature-matrix.md`·`hardware-compatibility.md`·`hardware/index.html` 사양표에 TRMNL 행 추가.

### 핵심 설계 결정
- **App Store 적법**: 신규 entitlement 0 — 기존 `com.apple.security.network.server`로 커버(Pixoo `/pixoo/frame`과 동일 LAN-HTTP 선례). resvg/Node/서브프로세스 일절 없음. TS SVG 레이어는 공유 불가라 Swift는 레이아웃을 손으로 재구현(D200H/Pixoo와 동일).
- **enrollment 비영속**: settings.json write 없이 in-memory. 폴링마다 파일 쓰면 thrash + UI 편집 레이스. 재시작 시 다음 폴링에 재등록(soft auth라 안전).
- **`vitest`/`tsc`/SourceKit green ≠ Swift 모듈 컴파일** — Apple 편집 후 반드시 `xcodebuild AgentDeck_macOS`로 실검증해야 HEAD 컴파일 드리프트를 잡는다.

---
