# 2026-04-18 — Claude usage stale truthfulness + OpenClaw 미인증 세션 숨김

### 문제
App Store-gated macOS 앱에서 Claude usage가 실제로는 OAuth token missing + 오래된 `usage-cache.json` fallback인데도 `oauthConnected=true`와 현재 `fetchedAt`처럼 노출됐다. 결과적으로 UI/D200H가 stale Claude quota를 정상 live usage로 오해하게 만들었다. OpenClaw도 Gateway port가 reachable이면 인증 실패(`gateway_token_missing`) 상태에서도 `openclaw-gateway` virtual session을 주입해 가재 크리처가 연결된 것처럼 보였다.

### 해결
- `ApiUsageData`에 `fetchedAt`/`stale` metadata를 추가하고, stale file-cache fallback은 `usageStale=true`, 원본 cache timestamp, `oauthConnected=false`, `tokenStatus=missing`으로 그대로 노출한다.
- `/usage`가 stale cache를 fresh fetch처럼 포장하지 않도록 `lastApiFetchTime`을 cache의 실제 `fetchedAt`으로 유지한다. stale 상태에서는 reset timestamp를 event에서 숨겨 오래 지난 reset time이 UI에 남지 않게 했다.
- `AgentStateHolder`가 stale usage event를 받으면 기존 reset time을 fallback으로 보존하지 않고 nil로 비운다.
- OpenClaw virtual `openclaw-gateway` session은 `cachedGatewayConnected == true`인 경우에만 sessions_list에 주입한다. `gatewayAvailable`/`gateway_token_missing`은 topology/status row에만 남고 terrarium/D200H 크리처는 나오지 않는다.
- OpenClaw Gateway token Settings copy를 정리했다. token은 AgentDeck token이 아니라 사용자가 Gateway에 설정한 shared secret(`OPENCLAW_GATEWAY_TOKEN` 또는 `gateway.auth.token`)이며, token-required 상태일 때만 입력 UI를 강조한다.
- D200H usage wide button도 stale cache일 때 `USAGE STALE` / `cached Claude usage`로 표시하고 gauge 색을 회색화한다.
- shared TS protocol의 `gatewayAuthStatus` union에 `gateway_token_missing`을 추가했다.

### 검증
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug build` — 성공
- Runtime `/usage`: `oauthConnected=false`, `usageStale=true`, `tokenStatus=missing`, `fetchedAt=1776480311640`, `mlxModels=["mlx-community/Qwen3.6-35B-A3B-4bit"]`
- Runtime `/status`: `sessions`는 daemon 1개만 포함, `modules.gateway.authStatus="gateway_token_missing"`, `gateway.connected=false`; 미인증 OpenClaw virtual session 없음
- Runtime `/status`: D200H `sessionsCount=0`, `lastStateHash`에 OpenClaw slot text 없음
- Runtime `/health`: ADB `available=false`, `disabled=true`; Pixoo/D200H/serial 상태는 계속 노출됨

---
