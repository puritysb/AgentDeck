# 2026-04-03 — App Store-Safe Optional Antigravity Access + Dashboard Preferences

### 문제
Antigravity 상태 표시는 `~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb`를 직접 읽는 방식이었다. 이 경로는 개발 환경에서는 동작할 수 있어도, Mac App Store 배포 기준의 App Sandbox와 맞지 않는다. 또한 Dashboard와 메뉴바 동작, Tank Status 섹션 노출 여부를 사용자가 조정할 방법이 부족했다.

### 해결
- `apple/AgentDeck/App/AppPreferences.swift`
  - 앱 전역 환경설정 객체 추가
  - Dashboard 자동 열기, 메뉴바 아이콘 스타일, Session list / Tank status / Timeline / Settings button 노출 여부 저장
  - `OpenClaw / MLX / OLLAMA / Antigravity / Subscriptions` 섹션별 표시 여부 저장
  - Antigravity DB는 보안 범위 북마크(security-scoped bookmark) 기반 opt-in 접근으로 전환
  - 기본값은 `showAntigravitySection = false`
- `apple/AgentDeck/Daemon/Core/UsageAPIClient.swift`
  - 더 이상 사용자 홈 경로를 직접 훑지 않음
  - `AppPreferences.shared.withAntigravityDatabaseAccess`를 통해 사용자가 승인한 `state.vscdb`에만 접근
  - Antigravity 정보는 확실한 `planName`을 읽을 수 있을 때만 생성
- `apple/AgentDeck/App/AgentDeckApp.swift`
  - 메뉴바에서 Dashboard show/hide 토글 제공
  - 메뉴바 아이콘 스타일을 `Status / App / Minimal`로 선택 가능하게 함
- `apple/AgentDeck/UI/Settings/SettingsScreen.swift`
  - Dashboard 패널/섹션 표시 제어 UI 추가
  - Antigravity 접근 허용/제거 UI 추가

### 원칙
- **App Store-safe by default**: Antigravity는 기본적으로 꺼져 있고, 사용자가 직접 파일 접근을 허용해야만 표시
- **정보를 못 읽으면 표시하지 않음**: 애매한 fallback이나 추정값 없이, 확실한 로컬 상태만 노출
- **Dashboard는 사용자 취향에 맞게 조정 가능**: 메뉴바 아이콘, Dashboard 자동 열기, Tank Status 섹션을 환경설정으로 제어
