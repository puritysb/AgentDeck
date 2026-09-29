# 2026-04-18 — Port drift resilience + MLX 4-layer picker + reset-time grace

### 문제
사용자 Dashboard에 동시다발 3가지 증상. (1) 디바이스들이 연결/해제 반복 + 일부는 끊어진 채 고정. (2) Tank Status 5h 리밋이 "now"로 박혀 표시. (3) MLX 모델이 3.6 아닌 3.5로 표시. 실상 확인 결과 Xcode Debug `AgentDeck.app`(pid 69905)이 9120에 bind 못하고 9121만 LISTEN + `~/.agentdeck/daemon.json` 부재 상태. **daemon hub 부재가 공통 뿌리**로 판단. 사용자 피드백: "9120 아니어도 다른 port로 떠서 모든 consumer가 정확한 상태 노출해야 한다."

### 해결
세 갈래 독립 수정, in-progress UI 리팩토링(AgentStatusIcon/ControlTowerPanel 989줄 등)은 사용자 scope로 보존.

- **Bridge port drift (`c6bbd1e8`)**: `DaemonWsClient`에 `portProvider: () => number | null` 추가. `connect()`가 null도 수용해 backoff loop에서 provider 재호출 → daemon이 나중에 뜨거나 fallback port로 옮겨도 session bridge가 자동 추종.
- **MLX 4-layer picker (`f8c37ab2`)**: `shared/src/llm-settings.ts`에 순수함수 `pickMlxModel(catalog, pin)` — pin-in-catalog > `MLX_FALLBACK_MODEL`-in-catalog > first > null. `mlx-probe.ts` + Swift `TimelineSummarizer` 모두 이걸 사용. **App Store 신규 설치** 사용자 (mlx-vlm 미설치)는 null 반환 → `queryMLX` HTTP 호출 자체를 skip, 10s timeout 블로킹 제거.
- **FormatUtils grace (`338e5a1a`)**: `formatResetTime(iso, graceSeconds: 3600)` — `remaining <= 0 && remaining >= -grace` 이면 "now", 그보다 과거면 nil(UI 숨김). `adjustUsagePercent` 1h grace 정책과 통일.

### 핵심 설계 결정
- **daemon port는 authoritative value가 아니라 dynamic**. 9120은 default이지만 bind 실패 시 fallback(`findAvailablePort`) → `daemon.json`에 실제 port 기록. 모든 consumer(bridge session, plugin, ESP32)는 daemon.json 또는 mDNS로 매 connect마다 재조회. Bonjour TXT + mDNS는 이미 port-agnostic. Plugin `connection-manager.setPortProvider`도 기존 구조. 브리지 session bridge가 마지막 취약점이었음 — 해결.
- **MLX "Not detected"는 UX-level로 구분**해야 함. `resolveMlxModel(probe)`는 CLI 경로용(MLX 설치 전제, 항상 string 반환), `pickMlxModel(catalog, pin)`는 UI/probe 경로용(nullable). 둘은 공존. Swift TimelineSummarizer는 후자를 미러링 — App Store 정책(Apple 2.5.2, subprocess 금지)상 앱이 MLX 자동 기동 불가이므로 null 경로가 정상 상태.
- **포맷터는 FormatUtils 단일 구현**. `TopologyRail.compactReset`, `ControlTowerPanel.formatResetTime` private 중복은 graceSeconds 파라미터를 받는 global `formatResetTime`으로 수렴 (ControlTowerPanel 쪽 통합은 사용자 in-progress 리팩토링 합병 시 함께 들어갈 예정).
- **in-progress 변경 존중 원칙**: `OpenClawAdapter.clientId` "agentdeck-dashboard" → "gateway-client" 변경, `AgentStatusIcon` 0.55s pulse 타이머 전환, `ControlTowerPanel` 989줄 리팩토링은 모두 사용자의 의도적 작업이라 scope 밖. 증상 재현 시 이것들도 후속 조사 대상.

---
