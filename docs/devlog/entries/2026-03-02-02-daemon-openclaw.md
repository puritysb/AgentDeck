# 2026-03-02 — Daemon 프록시 시 OpenClaw 스타일 미적용

### 문제
Daemon이 Gateway를 프록시할 때 Plugin은 bridge로 연결됨. `connMgr.getActiveAgentType()`은 bridge 연결이면 항상 `'claude-code'` 반환. daemon이 `state_update.agentType: 'openclaw'`을 보내지만 plugin이 이 값을 무시하여 모든 UI가 Claude Code 녹색 스타일로 표시. 추가로 Usage 버튼의 `currentCapabilities`도 올바른 값으로 설정되지 않아 OpenClaw model catalog/usage 페이지 미표시.

### 해결
`plugin.ts`에 `proxiedAgentType` 변수 도입. `state_update` 핸들러에서 `ev.agentType`을 저장하고, `broadcastStateUpdate()`에서 `proxiedAgentType ?? connMgr.getActiveAgentType()`으로 실제 에이전트 타입 결정. capabilities도 `proxiedAgentType === 'openclaw'`이면 `OPENCLAW_CAPABILITIES` 직접 적용 (daemon은 `agentCapabilities` 미전송).

Usage 버튼: `state_update`에서 `ev.agentCapabilities` 없고 `proxiedAgentType === 'openclaw'`이면 `setUsageCapabilities(OPENCLAW_CAPABILITIES)` fallback 호출 추가. 이로써 model catalog poll + OC usage poll 시작.

**근본 수정** (`daemon-server.ts`): daemon `state_update`에 `agentCapabilities: OPENCLAW_CAPABILITIES` + `modelCatalog` 추가. adapter `metadata` → `model_catalog` 이벤트 캐싱 + 즉시 broadcast. Gateway disconnect 시 `cachedModelCatalog = null` 초기화. Plugin fallback은 defense-in-depth로 유지.

### 교훈 / 핵심 설계 결정
- **프록시 계층은 원본 에이전트 정보를 투명하게 전달해야 함**: connection-level 감지(`getActiveAgentType()`)와 protocol-level 정보(`state_update.agentType`)가 불일치할 때, protocol-level이 우선해야 함
- **독립 상태를 가진 컴포넌트는 명시적 setter 호출 필요**: `broadcastStateUpdate()`에서 caps를 올바르게 계산해도, Usage 버튼처럼 자체 `currentCapabilities` 상태를 가진 컴포넌트는 `setUsageCapabilities()` 명시 호출 없이는 반영 안 됨. 파생 값 전파 누락 주의
- **daemon은 bridge와 동일한 프로토콜 계약 준수 필요**: `agentCapabilities`, `modelCatalog` 등 bridge가 보내는 필드를 daemon도 보내야 함. 누락 시 소비자(plugin/android)가 개별 fallback 필요 — 양쪽 수정(daemon 근본 + plugin defense-in-depth) 병행이 안전

---
