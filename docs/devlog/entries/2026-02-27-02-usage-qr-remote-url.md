# 2026-02-27 — Usage 버튼 QR 코드 표시 + Remote URL 자동 감지

### 문제
Stream Deck 버튼에서 QR 코드를 표시하여 휴대폰으로 스캔 → Claude Code remote-control URL이나 OpenClaw Gateway에 즉시 접속하고 싶음.

### 해결
1. `qrcode` 라이브러리의 `create()` API로 모듈 매트릭스 추출 → SVG `<path>` 직접 생성 (`plugin/src/renderers/qr-renderer.ts`)
2. Usage 버튼 페이지 사이클에 `'qr'` 페이지 추가. URL 소스: (1) `--remote` URL (PTY 자동감지) (2) OC Gateway
3. Bridge OutputParser에서 `remote_url` 이벤트 파이프라인: Parser → Adapter → StateMachine → WS → Plugin
4. QR 페이지에서 push → `pbcopy`로 URL 클립보드 복사

### 핵심 이슈: PTY cursor-forward 시퀀스가 URL을 파괴
Claude Code TUI는 문자 사이에 `\x1b[\d*C` (cursor forward) 시퀀스를 삽입. 기존 파서의 `processFeed()`가 이를 공백으로 치환하여 `https://claude .ai/code /...` 형태가 되어 URL 매칭 실패.

**해결**: `parseRemoteUrl()`을 raw ANSI 데이터에서 실행. cursor movement 시퀀스를 공백 없이 제거한 후 ANSI color strip → URL regex 매칭.

### 교훈
- 144×144 버튼에 QR Version 3 (29 modules) × 4px/module = 116px가 최적. 헤더 라벨 제거해야 충분한 크기 확보
- PTY 출력의 raw ANSI 데이터는 TUI 렌더링 시퀀스가 텍스트 사이에 삽입되어 있어, URL 등 구조화된 문자열 추출 시 cursor movement만 선택적으로 제거해야 함 (공백 치환 불가)
- `qrcode` 라이브러리의 `create()` API는 canvas/PNG 불필요 — 순수 모듈 매트릭스 반환으로 SVG 직접 생성 가능

---
