# 2026-04-04 — macOS App 전면 점검 + AI Control Tower MenuBarExtra

### 문제
macOS Swift daemon의 Node.js 대비 기능 갭, 슬립/네트워크 복원 리스크, MenuBarExtra 단순함, 세션 정렬 파편화 등 전반적 개선 필요.

### 해결 (Phase 1-4 전체 구현)

**Phase 1 — 인프라 안정성:**
- `NWPathMonitor` — WiFi/VPN/IP 변경 시 Bonjour republish + module wake + timeline sync (2s debounce)
- `SIGTERM` handler — Activity Monitor 강제 종료 시 daemon.json 정리 + crash log
- Stale data indicator — 연결 끊김 시 "Data from Xm ago" 배지 + 패널 60% dim
- Shutdown timeout 3s→5s + fallback `removeDaemonInfo()`

**Phase 2 — AI Control Tower:**
- `shared/src/session-utils.ts` — `stateRank`, `sortSessions`, `assignDisplayNames` 공통화. TUI/Plugin/aggregator/Apple/Android 6곳 통합. Plugin `projectName` mutation 버그 수정
- `MenuBarExtra(.window)` — 340×450 Control Tower 패널 (Attention/Active/Idle 3-tier, Models & Services, Rate Limits, Devices, Actions)
- `session_command` protocol — daemon이 특정 세션에 명령 포워딩 (shared type + Node.js + Swift)
- Voice TTS flow — PROCESSING→IDLE 시 chat_end TTS 응답
- Bonjour republish 3회 retry + TimelineRelay subscription cap 20
- Antigravity 15s SQLite probe, wake_word_detected broadcast callback
- Dashboard 관제: 키보드 숏컷 (⌘Y/N/⏎/.), 크리처 탭→세션 포커스, 토스트 알림

**Phase 3-4 — UX 폴리시:**
- Connection error recovery guidance ("Retry Discovery" 버튼)
- PID reuse guard (24h staleness), health check 5s
- Antigravity sandbox 설명, remove access confirmation dialog
- Session list overflow (10개 cap), tool progress lineLimit(2)

### 핵심 설계 결정

1. **MenuBarExtra label은 단순 `Image(systemName:)`만 사용** — ZStack/overlay/resizable Image는 NSStatusBar 변환 시 렌더링 깨짐 (긴 하얀 박스). 크리처 SVG는 패널 내부에서만 사용
2. **SwiftUI `Text(verbatim:)` 필수** — `Text("\(port)")`는 locale-aware라 9120→"9,120" 쉼표 삽입. 포트/토큰 등 숫자는 반드시 `verbatim:`
3. **세션 정렬은 shared에서 1곳 관리** — `(projectName, agentType)` 튜플로 번호 부여, 원본 mutation 금지 (Plugin이 `s.projectName = "#1"` 직접 수정하던 버그)
4. **Codex review P2 반영** — TimelineRelay failed 포트가 sync()에서 재구독 안 되는 버그 수정 (`!knownPorts.contains || subscriptions[port] == nil`)
5. **disconnectBridge() 버그 수정** — `preferredLocalBridgeUrl` 미초기화로 Settings 연결 해제 무효화

---
