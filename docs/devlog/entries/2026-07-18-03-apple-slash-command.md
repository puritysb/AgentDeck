# 2026-07-18 — Apple slash-command 진행 아이콘 패리티

- macOS/iOS 타임라인은 `/merge` 같은 slash-command의 `chat_start`를 `terminal.fill`로 구분한 뒤 그 사각형 심볼 자체를 회전시켰다. Android는 같은 진행 상태에서 공통 running 아이콘을 회전하므로 플랫폼 간 표현도 달랐다.
- Apple `turnRow`가 정지 상태에서는 기존 터미널 아이콘과 `CMD` 칩을 유지하고, 진행 중에만 `arrow.triangle.2.circlepath`로 교체해 회전하도록 기존 `RotatingTimelineIcon.rotatingSymbolName` 경로를 연결했다. task spinner가 이미 쓰던 동일 규칙이라 별도 상태·프로토콜 변경은 없다.
- `AgentDeck_macOS` Debug 및 `AgentDeck_iOS` Debug(iOS Simulator) 빌드 성공.
