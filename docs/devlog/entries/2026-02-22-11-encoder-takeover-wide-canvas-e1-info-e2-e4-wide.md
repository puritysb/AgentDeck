# 2026-02-22 — Encoder Takeover: Wide Canvas 옵션 목록 (E1 info + E2-E4 wide list)

### 문제
Encoder takeover 모드에서 4개 패널이 각각 독립 정보(context/focus/list/detail)를 보여주는 방식은 가독성이 낮음. Voice text의 wide canvas 기법이 훨씬 효과적.

### 해결
- `renderWideOptionList()` 추가: `panelCount * 200`px 단일 캔버스에 옵션을 세로 나열, `translate(-i*200,0)` 슬라이싱으로 패널별 SVG 분리
- `encoder-takeover.ts` 렌더 구조를 E1=context + E2-E4=wide list로 변경
- `autoScrollToIndex()`: 선택 항목이 visible area 밖이면 scrollY 자동 조정
- 기존 4-panel 할당 로직(`getPanelAssignment`) 제거, 단순화

### 교훈 / 핵심 설계 결정
- Wide canvas 슬라이싱 패턴은 voice text에서 검증됨 → 옵션 목록에도 동일 기법 재사용
- `option-dial.ts`는 수정 불필요 — 기존 `handleTakeoverRotate()` → `refreshEncoderTakeover()` → `autoScrollToIndex()` 체인으로 자동 연동
- 1그룹만 활성 시 focus panel 폴백 유지

---
