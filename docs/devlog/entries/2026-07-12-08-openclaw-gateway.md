# 2026-07-12 — OpenClaw Gateway 모델 오표시 수정

### 문제
- Swift `OpenClawAdapter`가 Gateway `models.list`에서 `default` role을 인식하지 못하면 첫 available 모델을 기본 모델로 선택했다. RPC catalog 순서의 첫 항목이 로컬 Qwen인 환경에서 실제 메인 세션 `zai/glm-5.2`와 무관하게 `/status`의 `openclaw-gateway.modelName`이 Qwen으로 표시됐다.
- 잘못 선택된 `gatewayModelName`은 재연결과 default 판별 실패 뒤에도 보존되어 오표시가 계속 남았다. Node model catalog 경로에도 같은 catalog-order fallback이 있었다.

### 해결
- Swift 모델 선택을 Gateway의 명시적 default/primary metadata → canonical `agent:main:main` 세션의 provider-qualified model 순으로 제한하고, catalog의 첫 available fallback을 제거했다. 둘 다 없으면 `gateway_model` nil 이벤트로 과거 캐시를 지운다.
- main session의 flat/nested model shape를 처리하고 catalog key와 일치하면 display name으로 변환한다. Node `getDefaultModelName()`도 default tag가 없으면 null을 반환하도록 정렬했다.
- `OpenClawToolNoiseTests`에 main-session 선택, provider qualification, 첫 세션 fallback 금지, nested shape 회귀 테스트를 추가했다.

### 검증
- `xcodebuild test -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -only-testing:AgentDeckTests_macOS/OpenClawToolNoiseTests` — 33/33 pass.
