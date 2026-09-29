# 2026-04-28 — Android tablet HUD 밀도 / e-book timeline 정리

### 문제

Android tablet HUD 가 macOS/iPad HUD 대비 과하게 커졌다. 좌측 SessionListPanel 은 340dp cap + 14dp padding + 14/12sp typography 로 넓고 성긴 카드처럼 보였고, 우측 TopologyRail 의 AgentDeck hub 는 macOS 의 inline spine row 가 아니라 별도 boxed card 로 렌더되어 시각 언어가 어긋났다. e-book 화면은 Codex cloud 식별성은 개선됐지만 timeline 영역에 제목/구획 신호가 없어 빈 흰 영역 아래 이벤트가 갑자기 노출되는 형태였다.

### 해결

- Android tablet `MonitorLayoutScale` 을 macOS HUD 비율로 되돌림: 좌측 max 220dp, 우측 max 300dp, edge 12dp, panel padding 8dp, body/sub/header 12/10/11sp.
- `MonitorHUD` tablet width ratio 를 SwiftUI 와 동일하게 좌측 `min(width * 0.22, 220)`, 우측 `min(width * 0.32, 300)` 으로 맞췄다.
- Android `TopologyRail` 의 boxed AgentDeck hub 를 제거하고 macOS 처럼 vertical spine + inline hub row (`AgentDeck :port` + hairline) 로 교체했다.
- Android downstream 설명 문구를 제거하고 `This tablet · dashboard client` 한 줄만 남겨 operational density 를 높였다.
- e-book `EinkEventLog` 상단에 `TIMELINE` 헤더를 추가해 구획을 명확히 했다.

### 검증

- `bash scripts/build-android-release.sh` 성공 → `dist/agentdeck-v0.4.1.apk`
- Lenovo tablet, Pantone6, CremaS 에 APK 재설치 및 `adb reverse tcp:9120 tcp:9120` 적용
- 실기기 screencap 확인: `/tmp/agentdeck-lenovo-final.png`, `/tmp/agentdeck-pantone6-final.png`, `/tmp/agentdeck-cremas-final.png`
- `git diff --check` 성공

---
