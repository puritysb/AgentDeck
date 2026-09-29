# 2026-04-11 - macOS Dashboard 상태/모델 카탈로그 복구

### 문제
- Mac 화면만 꺼졌다가 돌아온 뒤 macOS Dashboard App의 상태/모델 목록이 정상적으로 갱신되지 않음
- `/usage` 모델 카탈로그와 Dashboard/Menu Bar/D200H 노출 순서가 경로마다 달라질 수 있음
- 검증 중 macOS 테스트 타깃 링크와 signed debug build 번들링도 함께 깨져 있음

### Root Cause
1. macOS sandbox entitlement에 `/.openclaw/`가 없어 `openclaw models list --json`가 `~/.openclaw/.../models.json.*.tmp`를 쓰다가 `EPERM`으로 실패할 수 있었다. 이 경로가 실패하면 Gateway는 살아 있어도 모델 카탈로그가 비거나 stale 상태로 남는다.
2. 사용자의 설정처럼 실제 sleep이 아니라 display-off만 발생하면 `scenePhase` foreground 복구가 트리거되지 않을 수 있었다. 이 경우 WebSocket은 connected처럼 보이지만 데이터 수신이 멈춘 stale 상태가 지속될 수 있다.
3. 세션/모델 정렬 규칙이 공통화되어 있지 않았다. `refreshSessions()`의 task group 완료 순서, virtual OpenClaw session 삽입 위치, UI별 모델 표시 규칙이 서로 달라 기기마다 순서가 달라질 수 있었다.
4. signed build에서 `agentdeck-runtime`을 `Contents/Helpers` 아래에 넣어 codesign이 JS/source map까지 nested code처럼 검사했다. pnpm `.ignored_*` broken symlink도 helper runtime rsync를 깨뜨릴 수 있었다.
5. `AgentDeckTests_macOS`의 `TEST_HOST`가 실제 산출물 `AgentDeck.app/Contents/MacOS/AgentDeck`가 아니라 `AgentDeck_macOS.app/Contents/MacOS/AgentDeck_macOS`를 가리켰다.

### 해결
- `AgentDeck.entitlements`와 `project.yml`에 `/.openclaw/` read-write exception 추가. XcodeGen 재생성 시 누락되지 않도록 기존 `/.codex/`, `/Library/pnpm/`, USB entitlement도 `project.yml`에 동기화
- `DashboardDataRules`를 추가해 세션 정렬, 모델 카탈로그 canonicalize/merge/sort, OpenClaw 표시 라인 생성을 공유 규칙으로 통합
- `DaemonServer`의 session list/model catalog 경로와 macOS Dashboard/Menu Bar/Tank UI가 동일한 공유 규칙을 사용하도록 변경
- macOS `AgentStateHolder`에 stale-data watchdog 추가: bridge는 connected인데 일정 시간 데이터가 안 오면 preferred local bridge로 강제 재연결
- `OpenClawAdapter.emitModelCatalog()`에 빈 카탈로그 1회 지연 재시도 추가
- `agentdeck-runtime` 번들 위치를 `Contents/Helpers`에서 `Contents/Resources/agentdeck-runtime`으로 이동하고 `.ignored_*` rsync exclude 추가
- `AgentDeckTests_macOS`의 `TEST_HOST`/`BUNDLE_LOADER`를 실제 macOS 앱 산출물 경로로 수정

### 검증
- `xcodebuild build -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataDashboardSync CODE_SIGNING_ALLOWED=NO` - 성공
- `xcodebuild build -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS'` - signed debug build 성공. 다만 현재 로컬 debug signing 환경에서 직접 launch는 곧 clean shutdown되어, 실행 검증은 다시 unsigned debug build로 복구해 진행
- `xcodebuild build -project apple/AgentDeck.xcodeproj -target AgentDeckTests_macOS -configuration Debug -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO` - 성공
- `xcodebuild test -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO` - 스킴에 test action이 없어 실행 불가. `xcrun xctest` 직접 실행도 app-hosted test bundle 특성상 앱 심볼을 로드하지 못해 실행 불가
- Runtime `/health`, `/status`, `/usage` 모두 200 OK. `/status` 세션 순서는 OpenClaw, Codex, OpenCode, daemon으로 안정화됨
- Runtime `/usage` 모델 카탈로그는 7개 반환: default, fallback, configured 순서 유지
- `~/.agentdeck/swift-daemon.log` 최신 로그: `2026-04-11T01:01:36Z DEBUG [Daemon] Model catalog updated from gateway: 7 models`. 최신 구간에서 `EPERM`/empty retry 재발 없음

---
