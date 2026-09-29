# 2026-04-19 — non-AppStore macOS 분기 일괄 제거 + 외부 daemon 게이트 (progressive enhancement)

### 문제
macOS 타겟은 `apple/project.yml:61` base setting 으로 `AGENTDECK_APP_STORE` flag 를 항상 켜고 빌드한다. 즉 `#if !AGENTDECK_APP_STORE` 분기는 macOS 에서 한 번도 컴파일되지 않는 dead code. 그런데 이 분기 안에 `Process()` / `.command` 작성 / AppleScript / `openclaw doctor` / `networksetup` / `security` / `sqlite3` / bundled Node spawn / "Switch D200H to Bundled Helper" Settings UI 같은 Apple Review 2.5.2 위반 가능 코드가 1.4k LOC 살아있었다. 4-19 안티패턴 로그가 이미 한 번 회귀-복구 사이클을 기록한 상태였고, 같은 회귀가 다시 들어오면 컴파일 시점에 잡히지 않는다는 게 위험. 동시에 standalone App Store 앱은 sandbox 한계로 못 하는 기능(Claude OAuth quota, ADB-bridged Android/TC001)에 대해 "sandbox unavailable" 메시지를 노출하고 있어서, "결함 있는 앱"으로 보였다.

### 해결
**Phase 1 — 분기 자체 삭제 (`#if !AGENTDECK_APP_STORE` macOS).**
- `SessionLauncher` 를 NSAlert facade 로 단순화. `TerminalApp`/`LaunchPlan`/`openInTerminal`/`openInITerm`/`showAgentInstallPrompt` 전부 제거 (~150 LOC).
- `LaunchSessionDialog` 의 terminal 피커 삭제 (alert-only 로 가니 의미 소멸).
- `DaemonService.startBundledD200HHelper`/`stopOwnedExternalDaemonIfNeeded`/`resolveBundledD200HHelper`/`resolveRepoNodeDaemonLaunch`/`helperEnvironment` + `externalDaemonProcess`/`ownsExternalDaemon`/`d200hHelperPromotionAttempted` state + auto-promotion health-monitor branch 제거.
- `AdbModule` 을 status-only stub 으로 축소 (외부 daemon 이 broadcast 로 device 데이터 relay).
- `WifiConfig` 의 `networksetup`/`security` shellSync 제거 (사용자 수동 입력만).
- `BridgeLogStream` 을 parser-only 로 축소 (`OpenClawAdapter` 만 `parseLogLine` 사용).
- `GatewayProbe.checkHealth` 의 `openclaw doctor` 제거 (Gateway RPC 가 health 정보 push).
- `ESP32Serial.shellSync` / `UsageAPIClient.getOAuthCredentials` `/usr/bin/security` / `UsageAPIClient.sqliteValueViaShell` `/usr/bin/sqlite3` / `AnthropicAdminApiClient.currentKey` env-var fallback 제거.
- `SettingsScreen` 의 "D200H Helper" 섹션 + `autoUseBundledD200HHelper` `AppPreferences` 제거.
- `OnboardingSheet` 의 install-command 카드 + "Open Guide" 버튼 + 두-버튼 yes/no 인터랙션 제거 (App Store branch single-source).
- `IntegrationsView` 의 4개 copy 분기 collapse → App Store copy 단일화. Codex/Claude 안내 문구도 sandbox 한계 직접 언급하지 않게 재작성.
- `copy-adb.sh` 본체 비우고 `agentdeck-d200h-helper.sh` 삭제. `SessionLauncherTests` 의 `bundledBridge`-의존 케이스 제거 (DaemonService 단독 케이스 3개만 남김).

**Phase 2 — `DaemonService.isUsingExternalDaemon` 게이트로 progressive enhancement.**
- `ControlTowerPanel.rateLimitsSection` 에 가시성 조건 추가: 실제 gauge 데이터가 있거나 외부 daemon 이 붙어있을 때만 RATE LIMITS 헤더+섹션 노출. 미감지 시 `hookConsentHint` 만 분리 표시. `rateLimitsEmptyMessage` 도 "sandbox 안내" 톤 → "외부 daemon 동기화 중" 톤으로 재작성.
- `DevicePreviewCatalog.PreviewDevice.requiresDesktopBridge` 추가 (`androidTablet`/`einkMono`/`einkColor`/`ulanziMatrix`). `DevicePreviewScreen` 에 `@EnvironmentObject DaemonService` 주입 + `visibleDevices` 필터. 사이드바가 빈 카테고리는 자동으로 숨고, 외부 daemon 토글 시 `onChange`/`onAppear` 가 현재 선택을 안전한 첫 항목으로 옮김.
- `TopologyRail.emptyDownstreamPlaceholder` 의 "Android / Ulanzi TC001 are unavailable in the App Store build" 카피 삭제. 기존 `androidSection`/`pixelDisplaySection` 은 이미 `classifiedDevices`/`tc001Devices` 비어 있으면 렌더 안 하므로 외부 daemon 부재 시 자연스럽게 hide.

**검증**: `xcodebuild Release` 통과, `verify-appstore-archive.sh` 통과, macOS 단위 테스트 60개 전부 통과.

**문서/메모리**: `docs/appstore-feature-matrix.md` (Claude 구독 사용량 행 + 요약 + Anti-patterns 섹션 갱신), `apple/APP_REVIEW_NOTES.md` ("source tree contains no Process()" 로 강화), `CLAUDE.md` "App Store build invariants" (compile flag 의미 변경 + progressive enhancement bullet 추가), `docs/appstore-metadata-draft.md` ("install Claude Code first" 리드인 → "works immediately after install" 로 교체), `memory/appstore-invariants.md` (dead code 일괄 삭제 + progressive enhancement 패턴 기록).

### 핵심 설계 결정
- **`AGENTDECK_APP_STORE` flag 자체는 유지**. CI verifier 의 의미적 앵커이자 향후 회귀 가드. 다만 의미가 "분기 컴파일 조건" 에서 "검증 토큰" 으로 바뀌었다 — 새 subprocess 코드는 어떤 guard 안에서도 들어오면 안 됨 (CLAUDE.md 에 명시).
- **`OpenClawAdapter` identity 는 App Store Keychain v3 단일 경로로 정리**. 2026-04-19 후속 정리에서 Swift macOS 소스 트리의 file-based `~/.openclaw/identity/` fallback, `Process()` 기반 `openclaw models list`, `/usr/bin/env which openclaw` 경로를 제거했다. v2 file-based identity 는 Node CLI bridge 책임이고, macOS GUI 제품 경로가 아니다. `AnthropicAdminApiClient` Keychain 저장소는 유지.
- **`!isUsingExternalDaemon` UI 정책: 메시지 대신 hide**. "Subscription quota unavailable inside the sandbox" 같은 친절한 안내 카피는 사용자에게 "결함" 인상을 준다. 외부 daemon 미감지 시 해당 섹션 자체를 안 보여주는 쪽이 standalone 앱 완결성에 유리하다 — 사용자 답변 ("CLI daemon 없이는 보여줄 수 없으니 해당 영역 자체를 숨기면 좋겠다", "완결성있게 기능 제공이 가능한 것 처럼 보여주고 싶다") 직접 반영.
- **macOS 전용 build configuration variant 는 안 만든다**. 즉 `SWIFT_ACTIVE_COMPILATION_CONDITIONS=""` 로 강제로 끄고 빌드해서 비-AppStore macOS GUI 를 부활시키지 않는다. 그 제품 path 는 더 이상 maintained 가 아니고, full-spec 은 별도 Node.js bridge CLI 의 책임.
- **iOS 분기는 손대지 않음**. `AGENTDECK_APP_STORE` 는 macOS 전용 flag (project.yml 에 iOS 타겟엔 설정 없음); iOS 는 항상 App Store 전용이라 분기가 필요 없음.

---
