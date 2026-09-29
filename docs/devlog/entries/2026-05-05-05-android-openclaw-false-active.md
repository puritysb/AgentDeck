# 2026-05-05 — Android OpenClaw false-active 표시 보정

### 문제

Android 태블릿/e-book 대시보드에서 OpenClaw Gateway 가 인증되지 않았거나 끊긴 상태인데도
이전 worker 가재, OpenClaw 모델 라인, worker count 가 남아 OpenClaw 가 활성화된 것처럼 보였다.
원인은 Android `AgentStateHolder` 가 `modelCatalog`/`workerSessionCount` 를 null-coalescing 으로
보존하고, 일부 e-ink/portrait HUD 표면이 `gatewayConnected` 대신 stale catalog/count 를 직접
표시한 데 있었다. Node daemon 쪽도 Gateway disconnect 때 `sessions_list` 만 먼저 내보내고
`gatewayConnected=false` state update 가 늦게 도착할 수 있었다.

### 해결

- Android state merge 에서 `gatewayConnected != true` 이면 OpenClaw capabilities/sessionStatus/worker
  count 를 clear 하고, Gateway unavailable 상태의 stale error 를 false 로 수렴시켰다.
- Terrarium worker crayfish 는 인증 완료(`gatewayConnected=true`)일 때만 렌더 count 를 넘긴다.
- e-book compact/status/portrait header 와 tablet HUD worker count 를 `gatewayConnected` 기준으로
  게이트했다. tablet topology rail 은 reachable-but-unauthenticated 상태를 `Not connected` 로 표기한다.
- Node daemon 은 Gateway disconnect 이벤트에서 즉시 `state_changed` 를 emit 하고, Gateway unavailable
  probe 시 stale `gatewayHasError` 도 clear 한다.

### 검증

- `git diff --check` 성공.
- `./gradlew :app:testDebugUnitTest --tests dev.agentdeck.terrarium.TerrariumStateTest` 성공.
- `./gradlew :app:testDebugUnitTest` 성공.
- `pnpm --filter @agentdeck/bridge typecheck` 성공.
- `bash scripts/build-android-release.sh` 성공 → `dist/agentdeck-v0.4.1.apk`.
- ADB 설치 완료: Pantone6 (`AA007422R24C1300039`), Lenovo TB-J606F (`HVA095B4`), 둘 다
  `versionCode=5`, `versionName=0.4.1`, `lastUpdateTime=2026-05-05 12:42` 확인.

---
