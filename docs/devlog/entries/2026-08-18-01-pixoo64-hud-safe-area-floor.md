# 2026-08-18 — Pixoo64 하단 사용량 HUD 활성 시 크리처 Safe Area Floor 동적 클램핑

### 배경 및 원인
- Pixoo64(64×64 LED 매트릭스)에서 하단 Usage HUD(단일 공급자 시 Y 57~63, 듀얼 공급자 시 Y 50~63)가 70% 블랙 불투명 배경으로 최상단 오버레이 렌더링됨.
- 반면 유휴 상태(`idle`) 크리처들의 배치 수심(`worldY ≈ 0.80`, 화면 Y ≈ 51.2px, 스프라이트 높이 12~14px)이 바닥 모래사장 근처에 고정되어 있어, 하단 사용량 표시 영역 뒤로 크리처 하반신과 활동이 가려져 잘 보이지 않는 문제가 발생함.
- Crayfish(OpenClaw) 착석 위치 및 테트라 물고기 떼의 유영 하한선 역시 HUD 뒤로 묻힘.

### 개선 사항
- **Safe Area Floor 동적 적용**: 활성화된 Usage HUD 행 수에 따라 크리처 및 수조 환경 요소의 유휴 수심 하한을 HUD 상단 안전 구역으로 클램핑:
  - 듀얼 HUD (Y 50~63 점유): 크리처 중심 `Y ≤ 0.65` (약 41px)로 클램핑하여 HUD 상단(Y=50) 위쪽 수조에서 온전히 표시.
  - 단일 HUD (Y 57~63 점유): 크리처 중심 `Y ≤ 0.72` (약 46px)로 클램핑.
  - HUD 미표시: 기존 바닥 수심 (`Y = 0.80`) 유지.
  - 작업 중(`processing`, 상/중층 수심)인 크리처는 Safe Area보다 위에 있으므로 기존 자연스러운 유영 궤적 유지.
- **Crayfish 및 Tetra 물고기 떼 동기화**:
  - Crayfish 착석 Y(`cfY`)도 HUD 활성 시 Safe Area 상단(0.65 / 0.72)으로 조정.
  - 테트라 물고기 떼의 최대 유영 수심(`tetraMaxY`)을 HUD 상단선 위(46 / 52px)로 제한하여 HUD 뒤로 묻히지 않도록 개선.
- **Node.js 데몬 & macOS Swift 데몬 동기화 (SSOT)**:
  - `bridge/src/pixoo/pixoo-renderer.ts` 및 `apple/AgentDeck/Daemon/Modules/PixooRenderer.swift` 대칭 수정.
- **검증**: `bridge/src/__tests__/pixoo-creature-sync.test.ts`에 HUD 상태별 Safe Area Floor 단위 테스트 추가, 3,215개 전체 테스트 패스 확인.

---
