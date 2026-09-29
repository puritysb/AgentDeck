# 2026-04-18 — macOS App Store runtime stabilization

### 문제
Xcode run 상태의 App Store-gated macOS 앱에서 기본 daemon/UI는 동작했지만 런타임 상태 노출이 여러 지점에서 어긋났다. 실제 daemon은 fallback port `9121`에 떠 있는데 일부 UI는 `9120`을 표시했고, MLX 서버가 3.5/3.6 catalog를 모두 반환해도 Swift daemon은 정렬된 첫 모델인 3.5만 선택했다. OpenClaw Gateway는 살아 있었지만 `AUTH_TOKEN_MISSING`을 generic re-approve 상태로 보여줬고, App Store 빌드에서도 외부 `adb` 경로 탐지 때문에 ADB가 available처럼 보였다.

### 해결
- Swift `DaemonServer.probeMLX()`를 shared TS `pickMlxModel` 정책과 일치시킴: pin > `mlx-community/Qwen3.6-35B-A3B-4bit` > first > nil. 선택 모델(`mlxModels`)과 감지 catalog(`mlxModelCatalog`)를 분리해 state/usage 이벤트에 실음.
- daemon state에 실제 `daemonPort`를 추가하고 `TopologyRail`/`UnifiedGraphView`가 hardcoded `9120` 대신 실제 bound port를 표시하게 변경.
- App Store OpenClaw 경로에 Gateway token Keychain store 추가. Settings에서 `gateway.auth.token` / `OPENCLAW_GATEWAY_TOKEN` 값을 저장/삭제할 수 있고, 저장 시 daemon을 재시작해 `connect.params.auth.token`으로 재시도한다. `AUTH_TOKEN_MISSING`은 `gateway_token_missing`으로 분류.
- App Store ADB는 외부 binary discovery를 하지 않고 `available=false`, `disabled=true`로 보고한다. CLI/non-App-Store fallback은 유지.
- ESP32 serial은 동일 Wi-Fi provision payload를 같은 port에 반복 전송하지 않고, nonblocking partial write는 retry loop로 끝까지 쓰며 write failure는 per-port backoff 상태에 남긴다.
- App Store entitlement에 `com.apple.security.files.user-selected.read-write`와 `com.apple.security.files.bookmarks.app-scope` 추가.
- local macOS release export가 `apple/ExportOptions-macOS.plist`를 쓰도록 `scripts/build-apple-release.sh` 수정.

### 검증
- `swiftc -parse` on changed Swift files
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataRuntimeStabilization build CODE_SIGNING_ALLOWED=NO` — 성공
- `xcodebuild -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataRuntimeStabilizationNoDebugDylib build CODE_SIGNING_ALLOWED=NO ENABLE_DEBUG_DYLIB=NO` — 성공
- `bash apple/scripts/verify-appstore-archive.sh /tmp/AgentDeckDerivedDataRuntimeStabilizationNoDebugDylib/Build/Products/Debug/AgentDeck.app` — 성공
- `git diff --check` — 성공

---
