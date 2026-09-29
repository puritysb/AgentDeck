# 2026-04-22 — projectName resolves to git toplevel basename (monorepo subdir fix)

### 문제

`cd apple && agentdeck claude` 를 하면 Dashboard / plugin / iOS / macOS Terrarium 모든 surface 에서 프로젝트 이름이 `"AgentDeck"` 가 아닌 `"apple"` 로 표시. 원인은 `bridge/src/index.ts:184` 의 `process.cwd().split('/').pop() || 'unknown'` — 단순 cwd basename 이라 monorepo subdir 에서 상위 repo 아이덴티티를 잃음. 이 값은 `sessions.json` 과 `apme.sqlite runs.project_name` 에 각인돼 세션이 끝나기 전에는 스스로 고쳐지지 않음. 같은 버그가 APME collector fallback(`apme/collector.ts:97`) 과 Swift daemon 의 hook payload 처리(`DaemonServer.swift:1568-1574`, `1709-1715`) 두 곳에 복제돼 있어서 `cwd` 를 `lastPathComponent` 로 깎던 Swift 쪽도 동일하게 오염.

### 해결

단일 유틸 `resolveProjectName()` 도입 후 4곳 호출부를 모두 이 유틸로 수렴:

- **`bridge/src/utils/project-name.ts`** (신규) — fallback chain: `AGENTDECK_PROJECT_NAME` env → `git rev-parse --show-toplevel` basename → nearest ancestor `package.json` 의 `name` → `basename(cwd)` → `'unknown'`. git subprocess 패턴은 `apme/collector.ts:562` 의 `readGitHead` 를 그대로 복제(`stdio: ['ignore','pipe','ignore']`, 2s timeout, try/catch swallow). package.json walk 은 nearest-match(아니라 outermost) — monorepo 루트 케이스는 git 단계가 먼저 잡기 때문에 non-git 에서는 cwd-local 의미가 더 맞음.
- **`bridge/src/index.ts:184`** — `resolveProjectName()` 로 교체. **L219 도 같이 수정**: 기존 `adapter.getProjectName() || projectName` 에서 banner-parse 가 `output-parser.ts:694` 의 `/[~\/][\w.\-\/]+\/(\w[\w.\-]*)\s*$/m` 로 **마지막 path segment** 만 잡아 또 `"apple"` 을 반환하기 때문에 resolver 값을 덮어씀. 따라서 banner 는 버리고 resolver 단독 authoritative 로 전환.
- **`bridge/src/apme/collector.ts:97`** — `basename(input.projectPath)` fallback 을 `resolveProjectName({ cwd: input.projectPath })` 로 교체.
- **`apple/AgentDeck/Daemon/Core/ProjectNameResolver.swift`** (신규) — Foundation 전용(Process() 없음)으로 같은 계약. `.git` marker 탐색은 **dir 또는 file 양쪽 다 인정**(submodule/worktree layout). `package.json` 은 `FileManager.contents` + `JSONSerialization` 으로 파싱. cwd 가 sandbox 바깥이면 `fileExists` 가 false 반환 → 기존 `lastPathComponent` 경로로 graceful fallback, 무회귀.
- **`DaemonServer.swift`** — session_start inline 클로저(1568-1574) + `projectNameFromHookPayload` private method(1709-1715) 를 모두 `ProjectNameResolver.projectName(fromHookPayload:)` 로 교체. private method 는 삭제.

### 핵심 설계 결정

- **Stale data 는 migrate 안 함** (유저 명시적 요구): 기존 `sessions.json` 의 `"apple"` 은 라이브 세션 종료 시 PID prune 으로 자연 삭제. `apme.sqlite runs.project_name` 의 과거 행은 불변 유지. session-registry 에는 원래 `cwd` 가 저장돼 있지 않아 recompute-on-read 자체가 불가능. 새 세션부터 올바른 이름.
- **Swift 는 subprocess-free**: `AGENTDECK_APP_STORE` 컴파일 가드 불필요. 한 코드 경로로 dev + App Store 둘 다 커버. `verify-appstore-archive.sh` 의 forbidden-string 리스트(`Process()`, `/bin/sh`, `osascript`, `security`, `sqlite3`, `adb`, …)에 걸리지 않음.
- **`AGENTDECK_PROJECT_NAME` escape hatch 추가**: 한 줄 비용으로 "이 세션만 다른 이름" 요구 해결. 기존 `AGENTDECK_DATA_DIR` precedent 따름.
- **Banner parser dethrone**: `output-parser.ts:694` 가 `cwd` 마지막 segment 만 잡는다는 사실을 놓쳤다면 resolver 가 맞게 계산해도 L219 에서 여전히 `"apple"` 로 뒤덮였을 것. 앞으로 projectName 관련 수정 시 adapter.getProjectName() 도 같은 한계가 있다는 점을 잊지 말 것.

### 검증

- `pnpm test` 981/981 (14개 신규 `project-name.test.ts` + 기존 `state-machine.test.ts:330` 의 `'AgentDeck'` hardcoded assertion 포함 모두 그린)
- `pnpm --filter @agentdeck/bridge typecheck` clean
- `xcodebuild build-for-testing AgentDeck_macOS` **SUCCEEDED** (Swift compile clean; `xcodegen` 으로 `ProjectNameResolver.{swift,Tests.swift}` 자동 인식)
- `xcodebuild test` 는 본 머신에서 "test runner hung before establishing connection" 으로 타임아웃 — **내 변경과 무관한 기존 환경 이슈**. 동일 증상이 unmodified `SessionLauncherTests` 에서도 재현되고, memory 노트 `xctest-zombie-blocker.md` 의 "sudo kill or reboot" 케이스와 정확히 일치. `testmanagerd` 재시작만으로는 해소 안 됐고 리부트 후 재실행 필요.

---
