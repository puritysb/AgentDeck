# 2026-08-02 — PR #96 maintainer follow-up: Windows system layer without PTT/Launcher regressions

doug-w의 Windows Stream Deck 시스템 계층 PR 위에 maintainer 보완 커밋을
추가했다. 원 PR의 persistent PowerShell CoreAudio helper와 macOS/Windows
backend 분리는 유지하되, 리팩터링 중 삭제된 Stream Deck VOICE hold-to-talk
경로를 복구했다. keyDown→start, 250ms 이상 keyUp→stop, 짧은 탭 및
page/profile disappear→cancel을 `voice-ptt.ts`의 테스트 가능한 상태기로
분리하고 daemon wire mapping도 같은 모듈에 고정했다. `voice_state` 기반 키
facelift와 3초 error reset 역시 다시 연결했다.

Windows Launcher는 `cmd start`로 바뀌며 기존의 정확한 Start-menu 이름 확인과
`|url:` fallback 실패 신호를 잃던 부분을 수정했다. URL은 원 PR의 안전한
`rundll32` 단일 argv 경로를 유지하고, 앱 이름은 환경변수로 전달한
`Get-StartApps` exact lookup을 사용한다. 따라서 사용자 문자열은 PowerShell
source에 삽입되지 않고, 미설치 앱은 non-zero로 거절되어 URL fallback이 돈다.

---
