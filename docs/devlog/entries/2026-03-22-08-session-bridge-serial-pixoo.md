# 2026-03-22 — Session bridge에서 serial/pixoo 모듈 완전 분리

### 문제
`agentdeck claude`만 실행하고 daemon이 없을 때, Pixoo와 ESP32(TC001)가 session bridge로부터 직접 상태를 받고 있었음. 설계 원칙(daemon = sole hub for all dashboard devices)에 위배.

### 해결
- `cli.ts`: claude/codex 명령에서 `serial`/`pixoo`를 항상 `false`로 고정 (`--no-serial`/`--no-pixoo` 옵션도 제거)
- `index.ts`: `findExistingDaemon()` 기반 다운그레이드 로직 제거 (불필요), 기본값도 `serial: false`로 변경

### 핵심 설계 결정
- **mDNS/serial/pixoo 3개 모듈 모두 daemon-only**. Session bridge는 adb만 `'auto'` (reverse tunnel은 session 단위 필요)
- 이전 로직은 "daemon이 있으면 비활성화"였으나, 올바른 원칙은 "session bridge는 절대 활성화하지 않음". Daemon 유무와 무관하게 일관된 동작

---
