# 2026-07-15 — iOS/Android tablet display sleep 지속성·전환 경합 보강

### 문제
macOS `display_state{displayOn:false}`를 받는 iOS/iPadOS·Android LCD 태블릿 경로를 iDotMatrix 소등 문제와 함께 재점검했다. Android는 7/9 수정으로 full-off 시 `FLAG_KEEP_SCREEN_ON` 해제 + 밝기 0 + 2초 timeout이 이미 적용됐지만, 매 상태 snapshot마다 별도 coroutine을 띄워 DataStore `first()`에서 지연된 옛 off 작업이 빠른 wake 뒤 실행될 가능성이 있었다. iOS는 더 직접적인 결함 2건: (1) host가 계속 off여도 5분 timer가 사용자 밝기를 무조건 복원, (2) foreground 재진입 시 re-dim을 의도한 `pendingDim`이 어디에서도 true가 되지 않아 경로가 영구 no-op이었다.

### 해결
- **iOS/iPadOS** `DisplaySyncService`를 timer 기반 안전복원에서 desired-state 기반으로 변경. host off/full-off는 밝기 0을 명시적 wake·sync disable·bridge disconnect까지 유지하고, min 모드는 1–100% clamp, legacy dim 없음은 full-off로 처리한다. background/foreground 동안 host state+dim instruction을 보존해 UIKit이 밝기를 바꿔도 foreground에서 재적용한다. sync toggle을 끄면 즉시 원래 밝기로 복원. iOS 공개 API로 제3자 앱이 화면을 강제 lock할 수는 없으므로 OS auto-lock은 그대로 두고 brightness 0을 full-off 의미로 사용.
- **Android LCD** `MonitorService`에 단일 `displaySyncJob` 소유권을 두어 새 snapshot이 이전 정책 작업을 cancel. 이미 정립된 full-off(`KEEP_SCREEN_ON` 해제·brightness 0·2s timeout), min/disabled keep-awake, e-ink panel-awake 정책은 불변.
- 회귀 테스트: Swift `resolvedBrightness` 4종(full-off/wake, legacy, min clamp, disabled restore), Android screen policy 2종(dim disabled, keep-awake disabled) 추가.

### 검증
- Android `./gradlew :app:testDebugUnitTest` — BUILD SUCCESSFUL.
- Apple macOS-hosted `AgentDeckTests_macOS/ProtocolTests` — TEST SUCCEEDED.
- `AgentDeck_iOS` Debug, generic iOS Simulator, signing off — BUILD SUCCEEDED.
