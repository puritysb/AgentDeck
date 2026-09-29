# 2026-06-28 — Timebox Mini micro glyph: actual creature fidelity pass

### 문제
Divoom Timebox Mini(11×11 BLE)의 micro glyph 가 기기 해상도 제약을 고려하더라도 canonical creature 와 다르게 읽혔다. 특히 Claude 는 amber-eye 캐릭터처럼 보였고, Codex 는 하단이 cloud lobe 가 아니라 다리처럼 갈라졌으며, OpenCode 는 실제 단일 rectangular ring 이 아니라 겹친 사각형처럼 보였다.

### 해결
- Timebox Mini 렌더링 전략을 “작은 테라리움”이 아니라 **single dominant status badge** 로 명문화했다. 상태는 배경색이 담당하고, 전경 11×11 glyph 는 canonical mark 식별점만 남긴다.
- `bridge/src/pixoo/micro-glyphs.ts` SSOT 를 원본 asset + Pixoo/iDotMatrix small LOD 기준으로 재드로: Claude=two-row vertical dark cutout eyes + full-width robot arms + straight legs, Codex=rounded cloud + oversized `>_` + bottom cloud lobe, OpenCode=single tall hollow ring, OpenClaw=side claws + teal eyes(raised claws 는 11px 에서 과장돼 제외), Antigravity=transparent center hollow. Swift mirror 는 `pnpm generate-micro-glyphs` 로 재생성했다.
- Pixoo64/iDotMatrix shared renderer 의 Codex small LOD/MD 도 같은 원칙으로 정리했다. 기존 분리된 top/bottom lobes 는 작은 화면에서 다리처럼 보였으므로, rounded cloud body + prompt mark 형태로 변경하고 `pixoo-sprites.test.ts` 회귀 가드를 추가했다.
- `timebox-ble.test.ts` 에 각 glyph 의 identity pixel 을 고정하는 회귀 테스트를 추가했다.

### 검증
- `pnpm generate-micro-glyphs` 성공.
- `pnpm vitest run bridge/src/__tests__/timebox-ble.test.ts bridge/src/__tests__/pixoo-sprites.test.ts` 성공.
