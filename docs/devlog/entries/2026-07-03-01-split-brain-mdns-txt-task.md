# 2026-07-03 — 듀얼 데몬 공존 감사: split-brain 가드 · mDNS TXT 통일 · task 행 아이콘 패리티 · 관찰 세션 프로젝트명 통일

### 배경
3축 감사(데몬 공존 / 세션 프로젝트명 / 타임라인 표면 일관성) 결과 확정 결함 수정. 브랜치 `audit/daemon-timeline-consistency`.

### 구현
1. **데몬 split-brain 차단** — Node 싱글턴 가드는 파일(daemon.json/sessions.json) + 기본포트 probe만 검사했는데, App Store Swift 데몬의 daemon.json은 sandbox private container라 Node가 못 읽고(TCC hang 회피로 의도적 미독), 일시적 9120 경합으로 데몬이 fallback 포트(9121+)에 앉으면 둘 다 놓쳐 **이중 데몬**(mDNS 이중 광고·Gateway/timeline 중복 relay·adb reverse flapping). `scanDaemonPortWindow()`(9120–9139 병렬 /health sweep, Swift가 이미 하던 것의 Node 미러) + Swift 축출 시 고정 1500ms sleep 대신 `waitForDaemonExit()` health-gone 폴링(Swift가 serial/ADB/BLE 모듈 정리 전 인수하면 tty/adb reverse 이중 소유). `docs/daemon.md` singleton guard·client discovery 절 현행화(구 기술은 stale였음).
2. **mDNS TXT `v` 통일** — Node `v:'1'` vs Swift `v:'3'` (같은 `_agentdeck._tcp`). 현재 v를 읽는 클라이언트는 없어 Node를 '3'으로 정렬 + 양쪽 lockstep 주석.
3. **task 행 아이콘 패리티** — task_start/task_end/task_milestone이 TUI(`tui/renderer.ts` typeIcon)와 Android e-ink EventLog(`EinkEventLog.kt` typeIcon)에서 default 아이콘으로 뭉개짐(Apple/Android rich 타임라인만 표시). `timelineIconKey()` 의미(task→task 글리프, milestone→success)로 두 맵 보강.
4. **관찰 세션 프로젝트명 통일** — PTY는 `resolveProjectName()`(git root→package.json→basename), Swift 데몬은 `ProjectNameResolver.swift` 동일 미러인데 Node passive-observer만 `basename(cwd)` → 같은 프로젝트가 실행 경로 따라 다른 이름("AgentDeck" vs "bridge"), projectName 키 기반 `#N` dedup·Codex folding도 경로 간 분리. 신규 `resolveProjectNameFromCwdCached()`: 동일 순서, git 탐지는 서브프로세스 없는 `.git` ancestor walk(dir/file — Swift 미러와 동일 알고리즘, 스캔 이벤트루프 스톨 방지), cwd별 memoize.
   - **스크레이프 override 차단** — Claude PTY의 `OutputParser` PROJECT_DIR 정규식(아무 경로형 줄의 basename, first-match-sticks)이 state-machine snapshot을 타고 `bridge-core.ts`의 `snapshot.projectName ?? this.projectName` 우선순위로 git-aware 이름을 덮어씀(모노레포 서브디렉토리 세션이 repo명→서브디렉토리명으로 플립). `seedProjectName()`으로 resolved 이름을 파서에 시드해 스크레이프를 비활성(resolver가 'unknown'일 때만 fallback 유지, reset() 후에도 시드 유지). OpenCode(세션 제목)·OpenClaw(고정 'OpenClaw') 경로는 의도된 override라 그대로.
   - **OpenCode 어댑터** — `directory.split('/').pop()` basename fallback도 동일 리졸버로 교체(세션 title 우선은 유지).
5. **X4 포크 펌웨어**(crosspoint-agentdeck, 브랜치 `feature/agentdeck-timeline-consistency`) — Detail 타임라인을 타 표면과 정렬: entry.ts 포워딩+데몬시계 추정 나이 표시, 공유 `EINK_ICON_GLYPHS` 마커, chat_start turn 그룹핑, sessionId 없는 error/scheduled 행 유지, OFFLINE/Disconnected 문구 단일화. 기기 검증 대기.

### 미수정(확인만; 후속 후보)
- 영속 timeline.json/apme.sqlite가 Node(~/.agentdeck)와 Swift(sandbox container)로 분기 — 포트 소유자 교대 시 과거 히스토리 스왑(라이브는 relay로 정상). Group Container 재도입 또는 병합 로직 필요.
- TRMNL은 timeline을 안 그림(sessions만) — glance-only 설계로 판단, 필요 시 별도 결정.
- `agentdeck monitor` 브리지 행은 모니터 프로세스 cwd로 명명(훅 payload cwd 미사용) — 전역 훅이 모든 bare 세션에서 같은 포트로 POST하므로 훅 기반 rename은 다중 세션에서 flapping; 정확한 행은 passive observer가 별도 표면화하므로 의도적 보류.
- Node/Swift 타임라인 스토어는 손 미러링 2벌 — 공유 fixture 기반 projection 패리티 계약 테스트 부재.

### 검증
vitest 92파일/1649 pass(신규: scanDaemonPortWindow/waitForDaemonExit 5, resolveProjectNameFromCwdCached 4, seedProjectName 3), Android JUnit 195 pass, X4 `pio run` SUCCESS.

---
