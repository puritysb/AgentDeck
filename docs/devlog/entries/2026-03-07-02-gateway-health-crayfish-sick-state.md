# 2026-03-07 — Gateway Health → Crayfish SICK State

### 문제
OpenClaw gateway에 에러(memory sync 404, 채널 경고 등)가 발생해도 AgentDeck 대시보드에서 시각적으로 알 수 없었음. 가재 캐릭터에는 DORMANT/SITTING/ROUTING/OBSERVING/WAITING만 있었고, "시스템에 문제가 있다"는 상태가 없었음.

### 해결
전체 파이프라인 구현: Bridge → shared protocol → Android.

1. **Bridge**: `gateway-probe.ts`에 `checkGatewayHealth()` 추가 — `openclaw doctor --json` 실행, warn/error issue 감지. 30초 간격 폴링 (gateway 미접속 시 스킵)
2. **Protocol**: `StateUpdateEvent`에 `gatewayHasError?: boolean` 필드 추가
3. **Android**: `CrayfishVisualState.SICK` 추가. `toTerrariumState()`에서 `gatewayHasError=true`이면 DORMANT 외 모든 상태를 SICK으로 오버라이드

SICK 시각 효과: 55% 탈색 바디, -12° 기울기, 집게 아래로 축 처짐, 눈 흐릿 깜박임 (alpha 0.35-0.55), 더듬이 처짐, 느린 호흡. E-ink: gray `0x66` (평소 `0x33` 대비 washed out), -10° 기울기.

### 핵심 설계 결정
- Doctor 폴링 30초 — TCP probe(800ms)보다 훨씬 느린 cadence. `execFile`이므로 매 호출마다 프로세스 생성 비용 있음
- Doctor 실행 자체가 실패하면 `hasError=true` (보수적 판단 — 차라리 경고가 나는 게 나음)
- Doctor JSON 파싱 실패 시에는 `false` (노이즈 방지)
- DORMANT(gateway 자체 미접속)일 때는 SICK으로 오버라이드하지 않음 — DORMANT이 더 심각한 상태

### 함께 수정: OpenClaw 임베딩 404
`~/.openclaw/openclaw.json`의 `memorySearch.remote.baseUrl`에서 `/v1` 제거. OpenAI SDK가 자동으로 `/v1/embeddings` 추가하므로 이중 경로(`/v1/v1/embeddings`) 발생하고 있었음.

---
