# 2026-06-27 — Antigravity creature foundation for CLI daemon

### 문제
Antigravity 통합은 App Store-safe usage/credit DB 표시만 있고 `AgentType`/brand/glyph/session rendering 기반이 없어서, CLI daemon에서 Antigravity 프로세스를 발견하더라도 creature anchor 로 표시할 수 없었다. 기존 문서도 "Antigravity/OpenCode hook 없음"이라고 단정해 최신 제품 hook/plugin 표면과 App Store 제약을 섞어 설명하고 있었다.

### 해결
- **최신 판단 정정**: Antigravity/OpenCode 모두 hook/plugin/event 표면은 존재한다. 다만 App Store 앱은 외부 CLI/plugin/hook 설치, IDE/CLI spawn, process/port scan 을 하지 않으므로 coding-session 관측은 계속 미지원이다. CLI daemon 경로는 별도 companion tier 로 유지.
- **Antigravity agent 기반 추가**: shared `AgentType`, capabilities, protocol generation, sorting/rank, state color, SVG/brand renderers, TRMNL/D200H/Pixoo/Timebox micro glyph, TUI glyph, Apple/Android label/icon/formatter 경로에 `antigravity` 추가.
- **CLI daemon passive discovery**: Node passive observer 가 standalone Antigravity app/CLI/helper process 를 `observed:antigravity:<pid>` 세션으로 표출한다. 구조화 이벤트가 없는 경우에도 project cwd 기반 idle creature anchor 를 제공한다.
- **App Store 문서 정리**: `docs/appstore-feature-matrix.md`, `apple/APP_REVIEW_NOTES.md`, `docs/agent-harness.md` 를 "hook 부재"가 아니라 "App Store 앱은 외부 실행/설치/스캔을 하지 않는다"는 기준으로 갱신.

### 검증
진행 중: shared/passive observer focused tests, TypeScript typecheck, Swift/Kotlin compile smoke.

---
