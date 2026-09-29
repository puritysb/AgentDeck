# 2026-03-17 — Pixoo HUD 레이아웃 개선: 7d 추가 + gauge fill 제거

### 문제
Pixoo64 하단 HUD가 5h rate limit만 표시. 7d 데이터는 `UsageEvent`에 존재하나 렌더링 안 됨.

### 해결
1. **단일 행 two-column**: rows 57-63 하나에 좌측=5h / 우측=7d 나란히 표시
2. **Dark base 먼저**: full-width `blendPixel(black, 0.55)` → 카메라 와이드 시 모래(갈색) 은폐
3. **Gauge fill 제거**: 배경 fill로 usage를 표현하는 방식 폐기 — 텍스트 색상(blue/teal/amber/red)만으로 충분
4. **Compact format**: 5h=시간만(`4h`), 7d=일수만(`6d`) — 32px 존에 맞춤
5. **3 FPS**: 500ms → 333ms (디바이스 한계 ~4FPS 내 안전)

### 교훈 / 핵심 설계 결정
- **Pixoo HUD dark base 필수**: camera zoom에 따라 rows 57-63이 물(수면) 또는 모래를 표시. text-only 커버리지는 모래 노출로 갈색 배경 문제 → 항상 full-width dark base 먼저 깔 것
- **Gauge fill = 불필요한 복잡성**: 물 색상이 이미 usage zone을 표현하므로 HUD에서 fill 중복 불필요. 텍스트 색상만으로 충분
- **`d` 글리프**: 3×5 픽셀 폰트에 `d` 없어서 day 표시 불가 — 새 glyph `[0b001,0b001,0b011,0b101,0b011]` 추가

---
