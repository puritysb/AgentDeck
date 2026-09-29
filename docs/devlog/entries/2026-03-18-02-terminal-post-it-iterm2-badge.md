# 2026-03-18 — Terminal Post-it: iTerm2 badge 제어의 한계

### 문제
터미널 탭 전환 시 세션 컨텍스트를 즉시 파악하기 위해 iTerm2 badge에 자연어 요약을 오버레이하려 했으나, badge 크기/색상 제어에 심각한 제약 발견.

### 해결
1. **LLM 요약**: `timeline-summarizer.ts`에 `summarizeSessionContext()` 추가 — 도구 호출 이력을 MLX/Ollama로 한국어 1줄 요약. 5회 도구 사용 or IDLE 전환 시 트리거
2. **badge 크기 고정**: `SetProfileProperty` escape sequence는 **존재하지 않음** (iTerm2 Python API 전용). Dynamic Profile JSON (`~/Library/Application Support/iTerm2/DynamicProfiles/agentdeck.json`)을 생성 후 `SetProfile` escape sequence로 전환하는 방식으로 해결
3. **badge 색상**: Dynamic Profile의 `Badge Color` 프로퍼티로 amber(#FFC107, alpha 50%) 설정
4. **box-drawing 포기**: badge 폰트가 프로포셔널이라 `╭│╰` 정렬 깨짐 — plain text + emoji(📂)로 전환
5. **크기 제어**: `Badge Max Width/Height`는 터미널 크기의 **비율(0~1)**. 폭 넓게(0.5) + 높이 작게(0.05) 조합으로 줄바꿈 없이 작은 폰트 유지

### 교훈 / 핵심 설계 결정
- iTerm2 badge 제어 가능한 escape sequence: `SetBadgeFormat`(텍스트), `SetProfile`(프로필 전환) — 이 2개뿐. 크기/색상/폰트는 escape sequence로 불가
- `Badge Max Width/Height`는 점(points)이 아닌 **비율(fraction)**. iTerm2 소스(`iTermAdvancedSettingsModel.m`)에서 확인: `badgeMaxWidthFraction` default 0.5, `badgeMaxHeightFraction` default 0.2
- Dynamic Profile의 `Dynamic Profile Parent Name`으로 사용자 기존 프로필 상속 가능 — badge 속성만 오버라이드하면 나머지 설정 유지
- 프로포셔널 폰트에서 Unicode box-drawing은 사용 불가 — 정렬 보장이 안 됨

---
