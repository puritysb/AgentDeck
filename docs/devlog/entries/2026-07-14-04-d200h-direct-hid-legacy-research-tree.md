# 2026-07-14 — D200H direct-HID·legacy research tree 제거 + 루트 설정 정리

### 배경
- D200H의 유일한 지원 경로는 이미 `plugin-ulanzi/`(Ulanzi Studio 공식 플러그인)였지만, Apple 타깃에는 약 3,800줄의 비활성 `D200hHidModule.swift`, USB entitlement, stand-down arbitration, 직접-HID 진단/UI 설정이 계속 남아 있었다.
- 루트 `zkswe/`에는 폐기된 on-device C agent와 ADB/HID reverse-engineering 도구·현행처럼 보이는 오래된 상태 문서가 보존돼 있었다. Node 쪽에도 삭제된 renderer를 참조하는 `test-d200h.cjs`와 HID 나열 스크립트, dump-preview workflow가 남아 있었다.
- pnpm build-script 허용 설정이 `package.json`, `pnpm-workspace.yaml`, `.pnpm-approvedBuilds.json`에 서로 다른 형식으로 중복됐고, 실제 pnpm 11은 `package.json#pnpm`을 무시했다. GitHub 루트에서 이미 삭제된 `compatibility.json`을 조회하는 fallback도 코드에 남아 있었다.

### 정리
- Swift/Node 직접-HID 코드와 `node-hid`, `/d200h/refresh`, direct-HID 전용 설정·health 필드를 제거. D200H health는 양쪽 daemon 모두 `ulanzi-plugin` WS presence만 사용하며, 플러그인 미접속 시 topology row를 만들지 않는다.
- health payload가 `{connected, driver}`로 좁아진 것을 소비자 세 미러에 모두 반영. TUI(`bridge/src/tui/renderer.ts`)는 `externalOwner`를 읽던 탓에 D200H 행이 `ready plugin` → `ready`로 회귀했고, 그 회귀를 이제는 만들어질 수 없는 fixture(`{managerOpened, externalOwner}`)가 green으로 덮고 있었다. Android(`Protocol.kt`/`EinkStatusCompact.kt`)도 `D200hHealth` 9개 필드와 pending/error 분기가 도달 불가 상태로 남아 있어 Swift와 동일하게 `connected` 하나로 축소했다.
- 후속 review audit에서 Node `WsServer`에 남아 있던 미사용 direct-HID presence callback/non-WS command dispatch를 제거하고, Swift daemon의 단일 Ulanzi connection ID를 `Set<UUID>` presence roster로 바꿔 재연결 소켓이 잠시 겹쳐도 D200H 상태가 잘못 offline으로 전환되지 않게 했다.
- `zkswe/` 전체, 직접-HID 실험/덤프 스크립트와 workflow를 삭제. 현행 `plugin-ulanzi/`, 공용 `shared/src/d200h-layout.ts`, Apple Device Preview와 레이아웃 테스트는 유지했다.
- App Store USB entitlement와 관련 Review Notes를 제거하고 feature matrix/architecture/hardware 문서를 plugin-only 구조로 갱신했다.
- 지원 pnpm 범위를 11.x로 명시하고 `allowBuilds`를 `pnpm-workspace.yaml` 하나로 통합. exact `packageManager` 필드는 이 환경의 pnpm 자체 버전 관리가 오프라인 검증 전에 재설치를 시도해 `engines.pnpm` 범위로 대체했다. npm metadata만 사용하는 compatibility check로 단순화했다.
- 루트에 남아 있던 ignored GIF/log/profraw/scratch/test/compatibility 일회성 파일을 삭제했다.

### 검증
- `pnpm typecheck`, `pnpm test`(100 files / 1,770 tests), `pnpm verify-version` 통과.
- macOS Debug, iOS Simulator Debug, 서명된 macOS Release 빌드 성공. `AgentDeckTests_macOS` 404 tests, Android JUnit 227 tests 통과.
- 서명된 Release `.app`에 `apple/scripts/verify-appstore-archive.sh`를 실행해 App Store archive invariant 통과 및 USB entitlement 부재를 확인.
- TUI D200H 행을 실제 payload 4종(구 데몬 connected/disconnected, 신 데몬 connected, 신 데몬 키 부재)에 직접 렌더해 확인: 각각 `● D200H ready plugin` / `○ D200H offline` / `● D200H ready plugin` / 행 없음. 구 데몬 payload에도 `connected`가 있어 롤링 업그레이드 중에도 행이 유지된다.
- 후속 review audit 뒤 `pnpm typecheck`, TUI dashboard 10 tests, Android `:app:testDebugUnitTest`, macOS Debug unsigned build 통과.
