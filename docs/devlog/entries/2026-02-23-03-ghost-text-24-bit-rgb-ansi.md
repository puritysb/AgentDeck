# 2026-02-23 — Ghost Text 24-bit RGB ANSI 컬러 감지 수정

### 문제
Claude Code가 ghost text(추천 커맨드)의 ANSI 컬러를 SGR 90(`\x1b[90m`)에서 24-bit RGB(`\x1b[38;2;R;G;Bm`)로 변경. `GHOST_TEXT_RE` 정규식이 RGB 형식을 매칭하지 못해 E2 인코더에 추천 커맨드가 표시되지 않음. 디버그 로그: `ghostText: ❯-line found but no gray segments. raw=\e[38;2;153;153;153m❯ \e[39m...`

### 해결
`GHOST_TEXT_RE` 정규식을 `ANSI_SEGMENT_RE` + `isGrayForeground()` 함수 기반으로 교체:
- **`ANSI_SEGMENT_RE`**: 모든 SGR 세그먼트의 파라미터 문자열 + 텍스트를 캡처
- **`isGrayForeground(params)`**: SGR 90, 256-color grays (230-255), 24-bit RGB grays 판별
  - RGB 그레이 기준: `max - min ≤ 30` (저채도), `60 ≤ max ≤ 210` (중간 밝기)
  - `(153,153,153)` ghost text ✓, `(177,185,249)` blue ✗, `(80,80,80)` dark prompt char ✓ (but filtered by length)
- 테스트 3개 추가: 24-bit RGB gray 감지, non-gray 무시, 짧은 프롬프트 문자 필터링 (총 233 pass)

### 교훈
- 정규식 기반 ANSI 매칭은 새 컬러 형식 대응 불가 — R=G=B 산술 검증이 필요한 24-bit RGB는 함수 기반 판별 필수
- 그레이 판별 threshold(`max-min ≤ 30`, `60 ≤ max ≤ 210`)는 실제 PTY 로그의 색상값에서 도출: `(153,153,153)` ghost, `(136,136,136)` UI, `(80,80,80)` prompt char

---
