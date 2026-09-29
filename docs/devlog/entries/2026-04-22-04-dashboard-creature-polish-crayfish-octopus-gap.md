# 2026-04-22 — Dashboard creature polish: Crayfish 재배치 + Octopus 이름표 gap

### 문제

OpenClaw Gateway 가 연결되면 Crayfish 크리처(`crayfishDefaultX=0.78`, `crayfishSittingY=0.64`) 가 TIMELINE 하단 35% 밴드의 **Detail pane 반투명 배경(`Color.black.opacity(0.19)`) 뒤로 비쳐** 텍스트가 ghosting. 추가로 TopologyRail(`maxWidth = min(w*0.32, 300)` → 좌측 경계 대략 x 0.74~) 영역 안쪽에 들어가 UI 패널과도 겹침.

그리고 Claude(Octopus) 크리처의 프로젝트 이름표가 몸체로부터 너무 떨어져 "떠 있는 듯" 보임.

### 해결

**Crayfish 재배치**: x 0.78 → 0.68, y 0.64 → 0.60. 물속 하단에서 몸 바닥이 sand top(y=0.65) 에 닿는 위치. TopologyRail 좌측 경계(x≈0.74) 안 침범, Detail pane 영역(x>0.65, y>0.65) 바깥.

**Octopus 이름표 gap 축소**: `drawTerrariumNameTag(bodyTopY: cy - bodyRadius)` → `cy - bodyRadius * 0.583`. Octopus SVG viewBox 0~24 중 실제 body 는 y=5~20 만 차지하므로 bounding box 상단은 시각적 몸체 상단보다 `0.417 × bodyRadius` 위에 있음. 기존엔 그 공백까지 포함해 gap 이 잡혀서 bodyRadius 60pt 기준 약 25pt 의 잉여 여백 발생. OpenCode(`bodyW * 0.8`), Cloud(`bodyW * 0.6`) 는 이미 각자 factor 를 튜닝한 상태였고 Octopus 만 naive 하게 `bodyRadius` 를 통으로 넘기고 있었음.

### 핵심 설계 결정

- **SVG bounding box ≠ 시각적 body 상단**: Canvas 에 SVG 를 `offsetY = cy - viewBox/2 * scale` 로 그리면 viewBox 최상단이 bounding box 상단. 하지만 path 가 viewBox 전체를 채우지 않는 경우(Octopus 는 y=5 부터 시작) 이름표/UI overlay 는 path 의 실제 y 최소값 기준으로 계산해야 함. 향후 새 creature SVG 추가 시 viewBox 의 body 시작 y 를 바디 상단 ratio 상수로 뽑아 두면 실수 방지.
- **크리처 Y 는 "발이 바닥에 닿는" 기준**: `crayfishSittingY = sandTop - bodyHalfHeight` 공식이 자연스러움. TIMELINE top = 0.65, body half = 0.055 → Y = 0.595~0.60. 다른 creature 도 동일 규칙을 암묵적으로 따르고 있어 (AgentDeck #1 ≈ 0.68, #2 ≈ 0.78 but 둘 다 sand 밴드와 straddle) — 새 creature 추가 시 이 공식 적용할 것.

---
