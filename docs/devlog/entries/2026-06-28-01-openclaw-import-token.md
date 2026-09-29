# 2026-06-28 — OpenClaw "미연결" 원클릭 복구: 대시보드 Import token

### 문제
OpenClaw가 대시보드에서 계속 "미연결"로 떴다. 조사 결과 버그가 아니라 **config 갭**: gateway는 reachable(`available:true`)이지만 shared-token 모드라 토큰 없는 핸드셰이크를 1008 "gateway token missing"으로 거절 → `gatewayConnected:false`. Node 어댑터는 `~/.openclaw/openclaw.json`을 매 reconnect 직읽기해서 "그냥 됨"이지만, 샌드박스 Swift 데몬은 토큰을 **Keychain에서** 읽으므로 한 번도 Import 안 했으면 영구 `gateway_token_missing`. 커밋 `fd5dae13`(presence-driven 가시성)이 unauth gateway의 phantom 세션 주입을 막으면서, 늘 있던 토큰 갭이 이제야 "미연결"로 정직하게 드러났다. 대시보드 `SetupNeededCard`는 이미 이 항목을 띄웠지만 CTA가 제네릭 "Open Settings"뿐 — 복구가 Settings→Integrations→OpenClaw 3~4클릭 깊이에 묻혀 있었다.

### 해결
- `SettingsScreen.importOpenClawTokenFromConfig()`의 NSOpenPanel→parse→Keychain→bookmark→`reconnectGatewayAdapter()` 오케스트레이션을 공유 `OpenClawTokenImporter`(`apple/.../UI/Monitor/`)로 추출. Settings는 이제 위임만(동작 무변, `extractGatewayToken`은 테스트가 참조하므로 유지).
- `SetupItem`에 옵셔널 `primaryAction` 추가 → `SetupNeededCard`가 인라인 amber "Import token" 버튼 + 일시 피드백을 렌더.
- `openClawSetupAction`이 **token-remediable status에만** 버튼 부착: `gateway_token_missing`/`token_mismatch`/`connect_timeout`. pairing/device-auth(`pairing_required`/`device_auth_invalid`/`auth_failed`)는 Web-UI approve/reset-identity 사다리가 Settings에 있으므로 제네릭 "Open Settings" 유지.
- `MonitorScreen`이 platform-split `setupCard` 헬퍼로 macOS 변형에만 `daemonService` 주입(iOS는 Mac으로 라우팅하므로 import affordance 없음).

### 핵심 설계 결정
- **추출 후 위임**: import 플로우가 Settings 뷰의 private 메서드에 갇혀 있던 게 진짜 문제. 두 표면(Settings repair row + 대시보드 카드)이 동일 copy/action 재사용.
- **App-Store-safe 유지**: user-selected 파일 entitlement, security-scoped bookmark, 서브프로세스 없음 — 기존 플로우를 옮긴 것뿐. `directoryURL`은 Powerbox 힌트.
- status→action 매핑은 한 곳(`SetupNeededCard.openClawSetupAction`)에 집중.

### 검증
macOS `xcodebuild` BUILD SUCCEEDED, iOS 컴파일 green(서명 제외). verify-appstore-archive는 forbidden subprocess 문자열 0(나머지 실패는 Debug 산출물). 시각 확인은 Xcode rebuild 시 기존 Setup 카드의 OpenClaw 항목에 Import token 버튼 노출.

---
