# 2026-07-06 — 라운드 18: PERM 상태 명확화(RUNNING과 구분 + 진짜 대기 크리처 소멸 방지) + IPS10 attention-only

### 배경
BabelForge Claude Code 세션이 PERM(awaiting_permission) 상태였는데 (1) StreamDeck·D200H에서 RUNNING과 애니메이션/테두리가 거의 같아 PERM 인식이 어렵고, (2) 10" IPS에 과거의 ALLOW/DENY 팝업이 떠서 최근 정한 attention-only 방향과 불일치, (3) 오래 응답 안 하고 기다리니 해당 에이전트 크리처가 대시보드에서 **아예 사라짐**(세션은 남아있음).

### 해결
- **PERM ≠ RUNNING** (`shared/src/svg-renderers/session-slot-renderer.ts`, SD 키패드 + D200H 공유): 과거 RUNNING이 gold `#F5B942`로 override돼 awaiting amber `#f59e0b`와 동색 + 둘 다 동일 orbiting-march. 수정: RUNNING=쿨 teal `#2DD4BF` marching + RUN pill / PERM=amber **solid breathing**(전둘레 호흡) + bold **PERM** pill + amber PERMIT? 라벨. D200H detail info-slot 톤도 분리(PERMIT?=warning, RUNNING=info). 인코더 LCD는 이미 permission=red/diff=amber/option=blue라 무수정.
- **크리처 소멸 = 데몬별 근본원인이 다름** (진단 discipline: `lsof 9120`로 어느 데몬이 관측 중인지 먼저 확인):
  - Node managed(`agentdeck claude`): `state-machine.ts`의 10분 `AWAITING_STUCK_TIMEOUT_MS`가 안 답한 프롬프트를 IDLE 강등 → `isAwaiting` 필터서 소멸. **awaiting wall-clock backstop 제거**(real signal로만 탈출; PROCESSING 5분은 유지); `states.ts` awaiting stuck_timeout 전이 3개 삭제.
  - **★Swift observed(plain `claude`, App Store 데몬 실제 경로)**: Swift StateMachine은 processing만 stuck-arm이라 무관했으나, observed 세션은 `DaemonServer.swift evictStaleHookSessions`가 hook 없이 180s 지나면 **엔트리 통째 eviction**(state 무관) → 권한 프롬프트는 Notification 훅 1회 후 침묵 → 소멸. `awaitingHookStaleTTL=6h` 신설 + `entry.state.hasPrefix("awaiting")` 예외.
  - Node observed overlay `awaiting-overlay.ts` TTL 5분→6h(clear-on-next-hook primary).
- **IPS10 attention-only** (`esp32/src/ui/widgets/hud_bar.cpp`): 유일 터치 보드의 인라인 Approve/Deny + 모달 Approve/Deny 제거 → 부풀며 amber "AWAITING" + 질문 텍스트만(다른 보드와 parity). `permission_decision` 송신부는 unreachable로 잔존.

### 핵심 설계 결정
- **"진짜 사용자 대기"는 wall-clock으로 강등/eviction 금지** — 부재와 parser-miss를 타이머로 구분 못하므로, real signal(spinner/idle/response/stop)로만 탈출하고 죽은 세션은 liveness가 회수. observed는 시간 TTL이 유일 backstop이라 6h로 넉넉히.
- observed 크리처 소멸 디버깅은 state-machine이 아니라 **eviction/overlay TTL**이 원인 — "어느 데몬 관측?"부터 확인.
- IPS10 approve/deny 제거는 2026-06-19 결정(터치 승인)을 최근 attention-only 방향으로 뒤집음.
- 검증: vitest 1628/1628, shared/bridge build, macOS BUILD SUCCEEDED, ips10 firmware SUCCESS, 렌더 PNG 육안확인. 배포: Node 데몬 9120, SD·Ulanzi 플러그인 리로드, ips10 USB 플래시(buildHash 확인) + WiFi("swiss") 프로비저닝(persistent, otaSupported).
