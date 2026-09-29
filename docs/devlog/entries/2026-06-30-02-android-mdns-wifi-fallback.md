# 2026-06-30 — Android mDNS/WiFi 접속 fallback 검증 및 반영

### 문제
Android tablet/e-ink 앱이 USB reverse(`127.0.0.1:9120`) 실패 후 mDNS로 daemon을 찾아도, dual-homed Mac에서 Bonjour TXT `ip`와 Android NSD resolved host가 다를 때 한쪽 경로만 고집하면 WiFi 접속 복구가 막힐 수 있었다.

### 해결
- `BridgeDiscovery.kt`: TXT `ip`를 primary로 유지하되 link-local/IPv6/raw-invalid host를 제외하고, NSD resolved IPv4가 primary와 다르면 `fallbackHost`로 보존.
- `BridgeConnection.kt`: primary URL이 연속 실패하면 같은 pairing token을 유지한 fallback URL로 한 번 전환한 뒤 기존 re-discovery 흐름으로 복귀.
- tablet/e-ink/settings의 모든 mDNS connect 호출이 `bridge.wsUrl()`과 `bridge.fallbackWsUrl()`을 함께 넘기도록 배선.
- `BridgeDiscoveryTest`로 primary/fallback URL이 동일 pairing token을 유지하는 계약을 고정.
- stale test 보정: Android 정책상 Codex `tool_exec` firehose는 device timeline에서 제거되므로 `TimelineDisplayScenarioTest` 기대를 `TimelineStoreTest`/현재 devlog 정책과 맞춤.

### 검증
- `pnpm install --frozen-lockfile`, `pnpm build` 성공.
- Android `:app:compileDebugKotlin`, `:app:testDebugUnitTest`, `bash scripts/build-android-release.sh` 성공 → `dist/agentdeck-v0.1.0.apk`.
- Pantone 6(`AA007422R24C1300039`), Crema S(`CREMAA21W09235`), Lenovo Tab(`HVA095B4`)에 APK 설치/실행 성공.
- USB reverse 제거 후 세 기기 모두 mDNS로 `192.168.68.100:9120?token=...` 연결 `onOpen` 확인. host `lsof`에서도 `192.168.68.68`, `192.168.68.55`, `192.168.68.53` → `192.168.68.100:9120` 직접 ESTABLISHED 확인.
- 세 기기 `AndroidRuntime` fatal/crash 로그 없음. 검증 후 표준 배포 상태로 `adb reverse tcp:9120 tcp:9120` 복구.

---
