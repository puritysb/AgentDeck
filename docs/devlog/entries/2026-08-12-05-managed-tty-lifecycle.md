# 2026-08-12 — managed TTY 파서를 lifecycle 정본에서 분리

### 변경

- Claude/Codex managed terminal의 화면 관찰을 새 `terminal_ui` adapter source로
  격리했다. mode/diff/options/cursor/status처럼 upstream lifecycle payload가 아직
  제공하지 않는 실제 UI affordance만 허용하고, spinner/idle/tool 추측은 state,
  timeline, APME에 더 이상 전달하지 않는다.
- Claude PTY→telemetry adapter와 ringbuffer 응답 추출을 삭제했다. Claude lifecycle은
  hook이, 응답 본문은 Stop payload의 `transcript_path` JSONL이 정본이다.
- Codex turn manager의 PTY fallback state machine을 제거했다. lifecycle hook과 notify
  `codex_turn_complete`가 경계를 닫고, inline payload 또는 rollout JSONL이 응답/오류를
  공급한다. notify가 `codex_stop` 누락 시 StateMachine도 IDLE로 복구한다.
- `agentdeck daemon install`이 Claude/Codex/OpenCode 관측 통합을 모두 갱신하게 하고,
  README/setup/troubleshooting을 일반 `claude`/`codex`/`opencode` 실행이 기본이며
  `agentdeck <agent>`는 managed terminal/weight/remote attach용 선택 경로라고 정정했다.
- npm/CLI 1.0.19를 준비했다. wire compatibility는 기존 1.0 라인을 유지하며 lifecycle
  baseline은 Claude Code `>=2.1.50`, Codex CLI `>=0.141.0`으로 명시했다.

### 검증

- `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test` 통과(180 files,
  2,909 tests). 관련 6개 파일의 targeted Vitest 251개도 통과했다.
- `pnpm verify-version`, `pnpm docs:check`, targeted ESLint(error 0),
  `git diff --check`를 통과했다.
- PR #184를 squash merge(`4e959b4e`)하고 `npm-v1.0.19`를 같은 커밋에 태그했다.
  npm Release workflow `31610628648`이 네 public package를 게시하고 exact/latest 1.0.19를
  레지스트리에서 재검증한 뒤 GitHub Release를 생성했다. wire/UI 변경이 없어
  Apple/Android/Stream Deck/Ulanzi/ESP32는 재배포하지 않았다.

---
