# 2026-06-14 — OpenCode 크리처 전 표면 hollow-ring 재설계 + IPS10 2D 트리맵

### 문제
- OpenCode 크리처가 기기마다 제각각이고 원본 로고와 달랐다. 진짜 `design/brand/opencode.svg`(`M16 6H8v12h8V6zm4 16H4V2h16v20z`, **evenodd**)는 세로 직사각 **링**(outer 16×20, inner 8×12 hollow) 단색인데, 대부분 표면이 채워진 nested square + 어두운 inner 로 그려 **가운데가 그림자처럼** 보였다.
- 게다가 일부 표면은 아예 깨짐: **Pixoo32/iDotMatrix** 는 HD 그리드가 32px 를 오버플로우해 OpenCode 미표시, **TC001** 은 cyan(브랜드 아님) + 5×5 정사각, **Pixoo 상단 에이전트 점 인디케이터** 는 색이 octopus/jellyfish 2종뿐이라 opencode 점이 octopus 색으로 묻힘.
- IPS10 사이드바 모자이크가 좁은 세로 스택이라 공간을 못 채웠다.

### 해결 (uncommitted → 이번 세션 커밋)
- **OpenCode = 단색 hollow vertical ring 으로 통일**:
  - ESP terrarium: `generate-creature-glyphs.mjs` 에 OPENCODE evenodd 래스터 추가 → `creature_glyphs_generated.h` mask, `opencode.cpp` 가 그리드 대신 `Draw::alphaMask` 단색 hollow 렌더.
  - Pixoo(64/32/iDotMatrix): `pixoo-sprites.ts drawOpenCode` 그리드→**procedural hollow ring**(해상도 무관 스케일, 32px 해결).
  - TC001: `matrix_pages.cpp` 색 cyan→warm gray, sprite 5×8(과도)→**5×6 ring + dim 3×4 inner shadow**(다른 크리처와 키 맞춤, 깊이감).
  - e-ink/tablet: `drawEinkOpenCode`/`OpenCodeCreature.kt` thick-stroke ring(e-ink 은 B&W 대비 위해 dark stroke).
  - shared SVG: `agent-logos.ts` 3중 fill→evenodd path.
  - Pixoo 점 인디케이터: `pixoo-renderer.ts` 점 색에 opencode 분기 추가(`getOpenCodePaletteForSession().outer`).
- **IPS10 모자이크 → 2D 트리맵**: `hud_bar.cpp` absolute-positioned 셀 slice-and-dice(면적 ∝ activity weight, 긴 변 분할), rect lerp 유동. terrarium canvas 408 / 사이드바 372 로 폭 확대(`renderer.cpp`).

### 핵심 설계 결정
- **단일 캐노니컬 geometry 를 표면별 렌더 기법에 매핑**: 같은 evenodd 링을 ESP 는 빌드타임 alpha mask, Pixoo 는 procedural, tablet/e-ink 는 stroke, SVG 는 path 로. 펌웨어는 런타임 SVG 파싱 불가라 mask 가 정답.
- **TC001 같은 초저해상도(8px)에서는 hollow 가 비어 보여** inner 를 body 밝기의 40% dim shadow 로 채워 깊이 부여 — 큰 화면의 "그림자처럼 보임" 불만과 반대 방향이지만 매체 특성상 정당.
- ESP 플래시는 매 보드 `device_info_request` 재검증 후 진행(IPS↔AMOLED 오플래시 위험 차단). C6 는 probe 타이밍으로 1회 skip 후 재시도 성공.

---
