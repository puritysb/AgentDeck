# 2026-05-24 — Codex App passive detection / App Store subscription cleanup

### 문제
- Codex Desktop(App) kernel process가 이미 떠 있어도 OTel turn이 들어오기 전에는 Swift App Store daemon의 session list에 Codex App 타일이 늦게 나타날 수 있었다.
- OTel 익명 thread(`codex:otel-active`)가 별도 세션으로 남아 Codex App observed session과 중복 표시될 수 있었다.
- Claude Code만 미설정인 상황에서도 다른 agent 세션이 보이면 setup alert가 불필요하게 Claude Code를 요구했다.
- App Store daemon이 ChatGPT/Codex auth metadata를 subscription row로 합성해 Android tablet/e-ink surfaces에 renewal-needed row를 노출할 수 있었다.
- `/health`와 `/status`가 serial actor 상태 조회를 직접 기다려 물리 ESP32 쓰기 중 포트 탐색이 느려질 수 있었다.

### 해결
- macOS에서 subprocess 없이 `sysctl(KERN_PROC_ALL/KERN_PROCARGS2)`와 `NSRunningApplication`으로 Codex App kernel process를 passive 관측하고 `observed:codex-app:<sessionId>` 세션을 만든다.
- OTel `otel-active` 이벤트는 관측된 Codex App 세션으로 라우팅하고 기존 anonymous pushed state를 purge한다.
- Setup card는 보이는 agent가 하나라도 있고 그 agent가 Claude Code가 아니면 Claude Code setup 항목/alert를 숨긴다.
- App Store Swift daemon의 `subscriptions` payload는 빈 배열도 항상 전송하며, ChatGPT/Codex subscription row 합성은 제거했다.
- `/health`/`/status` module health는 serial actor await 대신 out-of-band poll cache를 사용해 hook port discovery 응답성을 유지한다.
- ESP32 serial bridge에서 write backpressure가 연속 발생하면 연결을 닫고 transient reconnect 경로로 넘긴다. Round AMOLED가 `write stalled after 0 ... errno=35` 상태로 계속 열려 있으면 `device_info`/`sessions_list`를 못 받아 loading 화면에 머물 수 있었다.
