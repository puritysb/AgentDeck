# 2026-04-28 — macOS session icon clipping / Pixoo Codex / Device Preview 현실감 개선

### 문제

macOS Dashboard 왼쪽 SessionListPanel 은 Codex/OpenClaw 아이콘을 공식 asset renderer 가 아니라 13×13 Canvas 에 SVG path 를 꽉 채워 직접 렌더했다. 두 path 모두 viewBox 경계까지 닿아 있어 macOS 안티앨리어싱에서 왼쪽 픽셀이 살짝 잘려 보일 수 있었다. Pixoo64 Codex cloud 는 10×8 sprite 라 Claude octopus 대비 납작하고 작게 읽혔고, `>_` 마킹도 1~2px 수준이라 실제 LED matrix 에서 티가 약했다. Device Preview 의 일부 non-key device mock 은 실제 화면 구조보다 큰 단일 creature 중심으로 보여 device별 HUD/세션/타임라인 밀도를 판단하기 어려웠다.

### 해결

- macOS `SessionListPanel` agent icon 을 공식 `SessionCreatureIcon` asset renderer 로 통일하고 16×16 slot 안에 13pt glyph + inset 을 둬 clipping 여유를 확보했다.
- Pixoo64 Codex sprite 를 13×11 cloud + 9×7 LOD 로 키우고, `>_` 마킹을 near-white 5px 패턴으로 재작성했다. Processing pulse 가 글씨 대비를 씻어내지 않도록 body pulse mix 도 낮췄다. Swift `PixooRenderer` port 와 Node `bridge/src/pixoo/pixoo-sprites.ts` 를 같은 grid 로 맞췄다.
- Device Preview 공용 building block (`PreviewCreatureGlyph`, mini session list, mini topology, aquarium scene, timeline strip) 을 추가했다.
- iPad / Android tablet preview 는 좌측 session list + 중앙 aquarium + 우측 topology rail 구조로 바꾸고, Android tablet 은 최근 실제 tablet HUD 조밀도에 맞춘 작은 sidebar/rail 비율을 반영했다.
- E-ink mono/color preview 는 header, session column, creature status, usage gauge, TIMELINE 영역을 가진 실제 e-book 화면식 레이아웃으로 교체했다.
- ESP32 / D200H key preview 도 badge형 거대 creature 대신 bare glyph 를 써서 실제 device HUD 안의 creature 크기에 가깝게 조정했다.

### 검증

- `pnpm --filter @agentdeck/bridge typecheck` 성공
- `pnpm vitest run bridge/src/__tests__/pixoo-sprites.test.ts` 성공
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataCreaturePreview CODE_SIGNING_ALLOWED=NO` 성공
- `git diff --check` 성공

---
