# 2026-05-04 — Xcode-run Apple diagnostics workflow for coding agents

### 문제

앱은 Xcode 에서 직접 실행/재현하고 코드 수정은 Claude Code/Codex 에이전트가 맡는 흐름에서,
Xcode console / OSLog / Swift daemon file log / `/diag` 상태를 매번 사람이 복사해 전달해야 했다.
그 결과 로그 누락, 포트 착각, in-process Swift daemon vs external Node daemon 혼동, hang sample 누락이
반복됐다.

### 해결

- `scripts/capture-apple-diagnostics.sh` 추가. repo-local 개발 도구로 daemon port 를
  `daemon.json` 또는 9120-9139 scan 으로 찾고, `/status`, `/diag`, `/devices`, `/usage`,
  Swift daemon log tail, AgentDeck OSLog, process list, 짧은 `sample` 을
  `diagnostics/apple-xcode/<timestamp>/` 에 수집한다.
- `.agents/workflows/apple-xcode-debug.md` 추가. Xcode 에서 재현된 Apple 앱 이슈는 사용자에게
  콘솔 복붙을 요구하기 전에 이 workflow 로 bundle 을 만들고 `diagnostics/apple-xcode/latest/`
  를 읽도록 표준화했다.
- `CLAUDE.md` 의 Development 섹션에 Apple/Xcode Debug Diagnostics 지침을 추가했다. 이 경로는
  App Store 앱 내부 기능이 아니라 저장소 측 개발 도구이며, App Store UI 나 Swift app source 에
  subprocess/terminal 안내를 추가하지 않는다는 경계를 명시했다.
- `.gitignore` 에 `diagnostics/` 를 추가해 수집 산출물이 커밋되지 않게 했다.

### 검증

- 앱 소스와 Xcode project 파일은 변경하지 않음.
- 수집 스크립트는 credential-bearing 파일(`auth-token`, `settings.json`, OpenClaw config)을
  의도적으로 제외한다.

---
