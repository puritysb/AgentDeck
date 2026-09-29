# 2026-03-18 — Daemon Hub 아키텍처 + daemon.json 포트 디스커버리

### 문제
1. **mDNS daemon-preference 버그**: EinkMonitorScreen에 daemon 우선 grace period 없음 → NSD가 session bridge를 먼저 발견하면 daemon 대신 session bridge에 연결
2. **`/health` 필드 불일치**: daemon은 `mode: 'daemon'`, session bridge는 `mode` 필드 없음 → Apple 클라이언트가 session bridge 식별 불가
3. **근본 설계 문제**: 모든 bridge가 각자 mDNS + WS 서빙하는 구조가 daemon-preference 로직의 근본 원인

### 해결
1. **EinkMonitorScreen**: `withTimeoutOrNull(4000)` 4초 daemon grace period 추가 (MainActivity 패턴과 동일)
2. **hook-server.ts**: `/health` 응답에 `mode` 필드 추가 (daemon과 동일한 필드명)
3. **Daemon hub 아키텍처 설계** (Phase 1 — daemon.json 포트 디스커버리):
   - `session-registry.ts`: `DaemonInfo` 타입, `writeDaemonInfo()`/`readDaemonInfo()`/`removeDaemonInfo()`/`probeDaemonHealth()`/`findDaemonPort()` 추가
   - `daemon-server.ts`: 3단계 singleton guard (daemon.json → sessions.json → /health probe) + 포트 fallback (non-daemon 점유 시 자동 대체) + bind 후 daemon.json 기록 + shutdown 시 삭제
   - 모든 클라이언트 (cli.ts, daemon.ts, dashboard.ts) 업데이트
4. **세션 전환 UI 지연 수정**: `cycleSession()`/`switchToPort()`에서 stale state 즉시 초기화 + `broadcastStateUpdate()` 콜백으로 전체 UI 플러시
5. **문서 전면 업데이트**: CLAUDE.md, README.md, docs/protocol.md, docs/devices.md, memory/MEMORY.md — daemon-only hub 아키텍처 반영

### 교훈 / 핵심 설계 결정
- **daemon.json이 정답**: `sessions.json` 스캔 + PID 검증보다 전용 파일이 단순하고 빠름. PID alive 검증 포함, stale 시 자동 삭제
- **`/health` probe가 최종 방어선**: daemon.json/sessions.json 모두 stale일 수 있으므로 실제 HTTP probe로 확인. 2s timeout
- **포트 fallback 시 EADDRINUSE race**: probe와 bind 사이에 포트가 잡힐 수 있음 → catch에서 `findAvailablePort()` 재시도
- **세션 전환 시 stale state = 시각적 지연의 원인**: `currentState`/`currentTool`/`currentModel`을 즉시 초기화하지 않으면 이전 세션의 상태가 잠깐 표시됨. `refreshAll()`은 세션 버튼만 갱신하므로 `broadcastStateUpdate()` 콜백이 필수

---
