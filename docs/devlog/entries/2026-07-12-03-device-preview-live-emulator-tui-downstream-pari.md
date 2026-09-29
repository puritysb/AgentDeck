# 2026-07-12 — Device Preview live emulator 확장 · TUI downstream parity

### 변경
- Device Preview live-follow 입력을 실제 daemon 세션·포커스·옵션·Claude/Codex usage snapshot으로 확장해 D200H와 단일 타일 프리뷰가 실제 프로젝트명·모델·상태를 렌더하도록 했다. Antigravity를 preview agent로 추가하고 Pixoo/TC001/iDotMatrix/D200H 경로와 회귀 픽스처를 보강했다.
- TUI dashboard downstream 영역에 Stream Deck, WiFi-only ESP32, TUI dashboard 행을 추가하고 serial+WiFi dual-home 보드는 중복 표시하지 않도록 했다.

### 검증
- `pnpm vitest run bridge/src/__tests__/tui-dashboard.test.ts` — 10/10 pass.
- `xcodebuild test ... -only-testing:AgentDeckTests_macOS/DevicePreviewSnapshotTests` — build/test 성공(매핑 1 pass, PNG 렌더 1건은 opt-in 환경변수 미설정으로 skip).
