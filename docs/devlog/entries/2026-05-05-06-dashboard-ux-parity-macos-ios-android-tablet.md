# 2026-05-05 — Dashboard UX parity: macOS/iOS/Android tablet 정렬

### 문제

macOS Dashboard 는 host-side 기능이 추가되어 있고 Android tablet 은 별도 Compose 설정/명령 경로를
쓰면서 iOS Dashboard 와 세부 경험이 갈라졌다. 특히 Android 는 세션 리스트/Attention 카드에서
focus session 을 먼저 보내지 않아 다중 awaiting 세션 응답이 iOS 와 다르게 라우팅될 수 있었고,
Display panels 토글 및 downstream device topology 가 iOS/macOS 와 맞지 않았다.

### 해결

- macOS Dashboard 의 특수 창/menubar 기능은 유지하면서, 빈 수족관 배경 탭으로 HUD 를 숨기는
  aquarium viewing interaction 을 iOS 와 동일하게 적용했다.
- Android tablet 에 `focus_session` command 를 추가하고 세션 리스트 row, Attention 카드 focus/respond
  경로에 연결했다.
- Android tablet settings 에 iOS 와 같은 `Mac integrations` read-only card 와 `Display panels` 토글을
  추가하고, 세션 리스트/토폴로지/타임라인/설정 버튼 표시가 해당 선호도를 따르도록 했다.
- Android protocol/state/topology rail 이 `moduleHealth` 를 수신해 Stream Deck, D200H, Pixoo, ESP32,
  Android/e-ink devices 를 downstream 관계로 표시하도록 맞췄다. 데이터가 없을 때만 `This tablet`
  fallback 을 유지한다.

### 검증

- `./gradlew :app:compileDebugKotlin` 성공.
- `./gradlew :app:testDebugUnitTest` 성공.
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination platform=macOS build` 성공.
- `git diff --check` 성공.

---
