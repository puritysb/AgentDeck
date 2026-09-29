# 2026-03-15 — TUI 모니터링 대시보드 (`agentdeck dashboard`)

### 문제
터미널에서 직접 에이전트를 모니터링할 방법이 없었음. SSH 환경, 리모트 서버, 추가 디바이스 없는 상황에서 실시간 상태 확인 불가.

### 해결
`bridge/src/tui/` 6개 파일 (~1700줄) + CLI 명령어 추가. 신규 의존성 없이 raw ANSI escape code로 구현.

- **WS 클라이언트 아키텍처**: Android/iOS 앱과 동일한 패턴 — `session-registry.ts` 자동 디스커버리 → daemon 우선 연결 → WS로 `BridgeEvent` 수신
- **적응형 3단계 레이아웃**: wide (120+), standard (80-119), narrow (60-79). `flushBuf()`에서 마지막 줄 `q quit` 힌트 예약
- **테라리움**: Braille 문자로 수중 생태계 애니메이션 (10fps). Octopus 14×5→7×2, Crayfish 16×8→8×2 (문어보다 크게), Tetra 5+5 boids
- **반블록 픽셀 폰트**: 4×6 픽셀 → 4×3 반블록(▀▄█) 변환. `FONT` 테이블 + `renderPixelFont()` 범용 함수
- **STATUS 2컬럼**: E-ink `EinkStatusCompact`와 동일한 LIMITS│MODELS 분할
- **로컬 타임라인 생성**: `state_update` 이벤트에서 상태 전환/도구 변경 추적 → `TimelineEntry` 생성. `receivingBridgeTimeline` 플래그로 bridge 이벤트 수신 시 로컬 생성 억제

### 교훈 / 핵심 설계 결정
1. **Width 계산 엄밀성**: 모든 라인이 정확히 `cols` 문자여야 터미널이 줄바꿈하지 않음. `borderFill(prefix, suffix, targetWidth)` 헬퍼로 동적 prefix 길이 대응. 하드코딩 hLine 길이는 connIcon/spinnerStr/staleTag 등 가변 콘텐츠에서 반드시 어긋남
2. **flushBuf 패턴**: 콘텐츠 행 수와 터미널 높이 불일치 시 마지막 줄(q quit)이 잘림 → `maxBoxRows = rows - 1`로 예약 + 잔여 행 클리어
3. **크리처 Y 위치**: idle=0.88(바닥 밀착), processing=0.30(수영), awaiting=0.50(중간). `lerp * 0.05`로 부드러운 전환. bob 진폭도 상태별 분리 (idle 0.005 vs processing 0.02)

---
