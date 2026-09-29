# 2026-06-27 — iDotMatrix / Divoom Timebox Mini 가 대시보드·패널에 안 보이던 문제

### 문제
두 BLE 매트릭스 패널(iDotMatrix 32×32, Timebox Mini 11×11)이 대시보드 토폴로지에 안 뜨고 패널 렌더도 깨졌다. 단일 버그가 아니라 3겹 plumbing gap이었다.

### 해결
- **Node 가시성**: Timebox는 정식 `TimeboxModule`인데 **iDotMatrix는 모듈 미등록**(직접 `startIDotMatrixSync` spawn만)이라 `buildNodeModuleHealth`/`/devices`/TUI/`agentdeck devices` 전부에서 누락. `IDotMatrixModule` 신설(Timebox 미러)+`createDefaultModules` 등록+health/devices/cli/TUI 분기+`ModuleConfigs.idotmatrix`. daemon-server의 직접 start 호출은 제거(모듈이 단일 소유).
- **Apple 가시성**: Swift 데몬은 `/health`에 idotmatrix+timebox `statusSnapshot()`을 이미 emit하지만 **클라가 버렸음** — `ModuleHealthState` 필드 없음+`BridgeEventParser.parseModuleHealth` 미디코드+`TopologyRail` 섹션 없음. 공유 `BLEMatrixHealth` struct+파서 분기+`bleMatrixSection`(statusReason→LEDStatus).
- **진단성**: 양 daemon-sync가 `stdio:'ignore'`로 Python 크래시(bleak/idotmatrix 미설치 등)를 삼켜 blank 패널이 무진단이었다. 공유 `bridge/src/ble-sync-spawn.ts`(stdout 묵음+stderr ring buffer, exit 시 tail 로그)로 교체. iDotMatrix는 설정 변경 시 재시작도 추가.

### 핵심 설계 결정
- **★ 실사용 즉시 원인 = settings 경로 분리.** App Store 플래그 빌드는 컨테이너 settings.json을 읽는데 `agentdeck ... add`는 `~/.agentdeck/`에 씀 → 앱이 `configuredDeviceCount:0`("no device configured")으로 아무것도 안 그림. 컨테이너 빌드는 앱 Settings 시트로 페어링해야 한다.
- **Swift 렌더 하드닝 후보 3건은 defect 아님(검증 후 변경 안 함)**: Timebox dim `max(0)`=의도(hw 밝기 없어 0=blank), TimeboxBLE settle 불필요(프레임당 1패킷+flow-control), wake stale-connected는 `handleWake()`가 이미 처리.
- **병렬 세션 브랜치 정리 중 Phase 1 Node 누락 → 재적용.** "Salvage … #30"이 Apple/Phase2/cli는 가져갔으나 iDotMatrix 모듈 등록+daemon-server health/devices 배선을 빠뜨려 Node 가시성 회귀. 본 브랜치에서 surgical 재적용.

### 검증
`pnpm build` green, `xcodebuild -scheme AgentDeck_macOS` BUILD SUCCEEDED, Node 데몬 e2e로 `/health`·`/devices`에 두 기기 표출 확인.

---
