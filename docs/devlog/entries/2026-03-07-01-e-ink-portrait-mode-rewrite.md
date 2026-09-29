# 2026-03-07 — E-ink Portrait Mode Rewrite

### 문제
Portrait 모드가 완전히 미구현 상태. `EinkPortraitLayout`이 스텁으로 남아서: agent panel 없음, EinkStatusCompact 미사용, EinkContextArea 미사용(AWAITING_PERMISSION 불가), refresh zone 없음, EinkFooterBar Row 클리핑 문제.

### 해결
1. **Portrait 레이아웃 전면 재작성**: landscape의 모든 컴포넌트(EinkAquariumFrame, EinkStatusCompact, EinkContextArea, EinkEventLog) 재사용. 세로 Column 배치 — Header(intrinsic) + Aquarium(35%) + Status(10%) + Context(15%, active시) + Timeline(40%).
2. **EinkPortraitHeader**: FlowRow 기반 적응형 에이전트 목록. 에이전트 수에 따라 폰트 축소(13→11→9sp) + `heightIn(max=80dp)` 상한. 프로젝트명 6자 절삭(9+개).
3. **EinkRefreshZone + 헤더 금지**: `AndroidView`가 `FrameLayout(MATCH_PARENT)` 생성 → Column 내 weight 없는 자식이 전체 높이를 소비하는 문제 발견. 헤더는 EinkRefreshZone 없이 직접 렌더링.
4. **Dialog immersive mode 복원**: `MainActivity.onWindowFocusChanged()` 오버라이드 — Settings Dialog 닫힌 후 시스템 바 자동 재숨김.
5. **EinkEventLog 텍스트 확대**: 10sp → 13sp.

### 교훈 / 핵심 설계 결정
- **EinkRefreshZone는 weight가 있는 자식에만 사용**: `AndroidView(MATCH_PARENT)` 특성상 Column 내 intrinsic height 자식을 래핑하면 전체 높이를 먹음. 반드시 weight modifier와 함께 사용하거나 직접 렌더링.
- **Dialog는 별도 Window 생성**: Android `Dialog`/`DialogProperties`는 새 Window를 만들어 기존 immersive mode 플래그를 리셋함. `onWindowFocusChanged`에서 포커스 복귀 시 재적용 필요.
- **적응형 FlowRow 패턴**: 에이전트 수에 따라 폰트/간격/이름길이를 단계적으로 축소하면 1~10+ 에이전트까지 동일 영역에 자연스럽게 수용 가능.

---
