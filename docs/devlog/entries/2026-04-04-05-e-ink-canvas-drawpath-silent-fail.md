# 2026-04-04 — E-ink canvas.drawPath() silent fail + 크리처 크기 정규화

### 문제
Crema S e-ink 디바이스에서 모든 크리처가 미표시. 수조 배경(물, 모래, 해초)은 보이지만 문어/가재/구름/OpenCode/물고기 전부 안 보임. 태블릿(Lenovo)에서는 정상. 또한 크리처 크기가 플랫폼 간 불균형.

### 해결
1. **근본 원인**: e-ink Canvas 구현체가 `canvas.drawPath()` 호출을 silent fail. Path 오브젝트(SVG path, Path.op UNION, cubicTo 등)는 렌더링 없이 무시됨. `drawRect()`/`drawCircle()`/`drawOval()`/`drawLine()` 기본 프리미티브는 정상 동작
2. **Claude Code**: SVG PathParser → 12×8 `drawRect` 픽셀 그리드 (ESP32 SSOT 일치)
3. **Cloud (Codex CLI)**: `Path.op(UNION)` + `drawPath` → 개별 `drawCircle()` 7개 (6 lobes + center)
4. **Crayfish**: cubicTo SVG body/claw → `drawOval()` body + legs + `drawLine()` antennae
5. **Animation loop**: try-catch 추가 — 크래시가 코루틴을 kill하여 초기 렌더(agents=0) 고정되는 문제 방어
6. **크기 정규화**: OpenCode -20% (0.08→0.064 Android, 0.055→0.044 Apple), Claude Code -10% (0.055→0.050), OpenCode 테두리 inner 50%→60% (더 얇게)

### 핵심 설계 결정
- **E-ink에서 `drawPath()` 금지** — Rockchip RK3566 (Crema S) Canvas 구현이 complex Path를 지원하지 않음. 향후 e-ink 크리처 추가 시 반드시 기본 프리미티브만 사용
- **Animation loop crash 방어**: try-catch 없으면 한 크리처의 렌더 실패가 전체 수조 갱신을 영구 중단시킴 (coroutine silent death). 초기 렌더만 표시되어 "배경만 보이고 크리처 없음" 증상 발생
- **진단 팁**: `adb logcat | grep EinkFrame`으로 agents/clouds/oc/crayfish count 확인 가능

---
