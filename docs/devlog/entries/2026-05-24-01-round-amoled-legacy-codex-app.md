# 2026-05-24 — Round AMOLED legacy Codex App 호환

### 문제
- Round AMOLED 보드는 자동 업로드가 ROM bootloader 진입에 실패해 Codex App 지원 펌웨어를 아직 플래시하지 못했다.
- 해당 보드는 `version=0.1.0`으로 붙고, 구형 펌웨어는 `codex-app` agent type을 모르면 Claude Code creature fallback으로 표시할 수 있었다.

### 해결
- Swift serial bridge가 `round_amoled` + firmware `< 0.1.1` + protocol revision 미광고 보드에만 `codex-app`을 `codex-cli`로 내려보낸다.
- 변환은 per-connection으로 적용해 Android/D200H/Stream Deck 및 새 ESP32 펌웨어의 Codex CLI/App 분리는 유지한다.
- `device_info`를 받은 직후 initial state를 다시 보내, 재연결 시 `sessions_list`가 구형 round 보드에도 보정된 agent type으로 도착하게 했다.
- 새 ESP32 펌웨어는 `version=0.1.1`, `protocolRevision=2`를 광고한다. 이 버전이 round에 플래시되면 호스트 별칭 없이 `codex-app`을 직접 렌더링한다.

### 검증
- `xcodebuild test -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -destination 'platform=macOS' -only-testing:AgentDeckTests_macOS/ProtocolTests`
- `pio run -e round_amoled`
- 실제 round 업로드는 여전히 `Failed to connect to ESP32-S3: No serial data received`로 실패했다. 물리 BOOT/RST로 ROM bootloader에 넣어야 플래시 가능하다.
