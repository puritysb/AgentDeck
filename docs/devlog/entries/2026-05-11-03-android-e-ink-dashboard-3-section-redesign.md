# 2026-05-11 — Android E-ink Dashboard 3-section redesign

### 문제

`E-ink Dashboard.html` 디자인 핸드오프의 최종 방향은 App Store 출시 준비 맥락에서
E-ink 화면을 세션 목록 / 테라리움 / 텍스트 Timeline 중심으로 단순화하는 것이었다.
기존 Android `EinkMonitorScreen` 은 중간 status band 에 LIMITS / MODELS / DEVICES 를
크게 표시하고, landscape 에서 좌측 session rail 이 전체 높이를 차지해 실제 디자인의
"상단 Sessions|Terrarium + 하단 Timeline" 구조와 어긋났다.

### 해결

- Android E-ink landscape 를 chrome bar + optional Attention strip + `Sessions | Terrarium`
  상단 row + full-width text `EinkTimelinePanel` 하단 row 로 재구성했다.
- Portrait 도 동일 의미의 `Sessions / Terrarium / Timeline` 3단 stack 으로 정리하고,
  terrarium 을 세로 lane 으로 늘리지 않게 유지했다.
- rotate/settings controls 를 screen chrome 으로 이동했다. rotate 는 settings button
  표시 여부와 독립적으로 계속 노출된다.
- LIMITS 는 fresh 5h/7d usage 값이 있을 때만 terrarium 우하단 작은 corner card 로
  표시한다. 값이 없거나 stale 이면 App Store-safe progressive enhancement 원칙대로
  섹션 자체를 숨긴다.
- 기존 `EinkAgentPanel` 은 brand header / footer controls 를 숨길 수 있는 옵션을
  받아 chrome 이 별도로 존재하는 dashboard layout 에 재사용되도록 했다.
- `docs/android-ui.md` 의 E-ink projection 설명을 새 3-section layout 으로 갱신했다.

### 검증

- `cd android && ./gradlew testDebugUnitTest` — BUILD SUCCESSFUL.

---
