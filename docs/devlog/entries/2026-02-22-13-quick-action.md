# 2026-02-22 — Quick Action 버튼 물리 위치 정렬

### 문제
Quick Action 버튼(슬롯 3-5)이 `onWillAppear` 호출 순서(비결정적)로 `actionIds` 배열에 추가되어, 물리적 버튼 위치와 슬롯 번호가 불일치. IDLE 기본 버튼, Permission YES/NO/ALWAYS, 프로젝트 피커 모두 영향. 추가로 `layout-manager.ts`에서 `opt.shortcut || 'y'` 폴백이 shortcut 없는 모든 옵션을 YES로 매핑하는 버그 발견.

### 해결
- `actionIds: string[]` → `actionCoords: Map<string, number>` (id → column)으로 변경
- `getSortedIds()` 헬퍼가 column 순 정렬된 ID 배열 반환
- shortcut 폴백: `opt.shortcut || opt.label.charAt(0).toLowerCase()` (diffButtons와 동일 패턴)

### 교훈 / 핵심 설계 결정
- **Stream Deck SDK `onWillAppear` 순서는 비결정적** — 항상 `ev.action.coordinates`로 물리 위치 판별 필요
- 배열 인덱스 기반 슬롯 매핑은 도착 순서 의존성 → Map + 정렬 패턴이 안전

---
