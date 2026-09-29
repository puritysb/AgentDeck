# 2026-07-17 — 32×32 identity stage + 11×11 shaded beacon + Codex token limits

### 문제
- iDotMatrix 32×32 전용 렌더러도 낮은 채도의 수조/지형이 공식 마크와 경쟁해 색이 탁하고 구성이 축소판처럼 보였다. Node `/pixoo/frame?size=32`는 여전히 64px 장면을 축소해 Swift 네이티브 경로와도 달랐다.
- Timebox Mini의 9×9 공식 마크는 실루엣은 맞지만 2단계 명암과 흩어진 외곽 상태점 때문에 4-bit 실기에서 평평한 픽셀 덩어리처럼 읽혔다.
- Codex rollout의 실제 primary/secondary rate-limit 데이터는 앱과 ESP32 protocol까지 도달했지만 Pixoo64·iDotMatrix·TC001 dot-matrix 출력에는 표시되지 않았다.

### 해결
- **iDotMatrix**: Node/Swift를 같은 네이티브 32×32 identity stage로 통일했다. sand/terrain을 제거한 blue-black field, 고채도 coral/violet/white/red palette, 18/13/10px 공식 마크, mask-aware shadow/halo를 사용한다. 하단 4개 고정 rail은 Claude 5h/7d와 Codex primary/secondary를 source key + 사용률로 표시한다.
- **Timebox Mini**: 생성 공식 9×9 geometry는 유지하되 alpha를 4개 4-bit-safe 명암으로 양자화하고 상→하 lighting을 추가했다. 외곽은 항상 연결된 dim frame이며 processing/awaiting/error/idle 강조만 그 위에서 움직인다. 11px에서는 identity를 해치는 usage rail을 의도적으로 생략했다.
- **Pixoo64 / TC001**: Pixoo64 하단 Claude HUD 위에 violet/indigo Codex 2줄 rail을 추가하고 Codex-only일 때 `Cnn` gauge를 표시한다. TC001은 Claude USAGE와 분리된 violet Codex primary/secondary 페이지를 데이터가 있을 때만 자동 순환한다. stale Codex window는 모든 새 dot-matrix 경로에서 숨긴다.

### 검증
Node/Swift 11px·32px nearest-neighbor montage 시각 검수, bridge typecheck/build, 전체 Vitest 102 files / 1,815 tests, Swift Timebox+iDot/Pixoo 집중 tests, TC001 `led8x32` PlatformIO build, `git diff --check` 통과. TC001 빌드는 Intel Homebrew `pio`와 arm64 `littlefs` 혼선을 피해 arm64 `~/.platformio/penv/bin/pio`를 사용했다.
