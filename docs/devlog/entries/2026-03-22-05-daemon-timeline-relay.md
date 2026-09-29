# 2026-03-22 — 다중 클라이언트 파편화 진단 + Daemon Timeline Relay

### 문제
Android/Apple/TUI/Plugin 4개 클라이언트에 mDNS 디스커버리, WS 재연결, Timeline 생성 등 공통 로직이 분산 구현되어 유지보수 리스크 존재. KMP/Rust 통합 제안 검토 필요.

### 해결
코드 탐색 결과 **실제 중복은 Timeline(~580줄) + Protocol 타입(~700줄)만** — 네트워킹(mDNS/WS/waterfall)은 의도적 플랫폼 분기로 확인. KMP/Rust 대신 경량 대안 2개 구현:

1. **SessionTimelineRelay** (`bridge/src/session-timeline-relay.ts`): Daemon이 sibling session bridge WS에 연결하여 `timeline_event`/`timeline_history` relay. 클라이언트 `StateTimelineGenerator` 불필요화
2. **Protocol codegen** (`scripts/generate-protocol.sh`): `protocol.ts` → JSON Schema → quicktype → Swift/Kotlin 자동 생성. `pnpm generate-protocol`

### 교훈 / 핵심 설계 결정
- 코드 중복과 의도적 플랫폼 분기를 구별해야 함 — Apple의 NWConnection endpoint resolution과 Android의 NsdManager TXT 선호는 각 OS의 특성에 맞는 의도적 선택
- KMP/Rust는 1,300줄 중복에 수주 FFI 인프라라 과잉 — 서버사이드 통합(daemon relay)이 ~130줄로 동일 효과
- 역대 버그(stale IP, localhost retry, reconnect race)는 전부 플랫폼 고유 동작에서 발생 — 공통 코어로 방지 불가

---
