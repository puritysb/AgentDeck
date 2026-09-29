# 2026-07-11 — 턴 앵커 유실-Stop 드리프트 수정(FIFO→open-turn 트래커) + APME run projectName 보강

### 문제
1. **앵커 큐 어긋남**: Swift 데몬의 claude/codex `chat_start` ts FIFO 큐(`ChatStartTsQueue`)는 매 턴 Stop hook이 도착할 때만 정확했다. 한 번 유실되면 고아 head가 남아 이후 모든 Stop이 **이전 턴**의 앵커를 pop — 영구 off-by-one으로 chat_response가 엉뚱한 턴에 병합되거나, 고아 entry가 10분 TTL에 걸린 뒤에는 앵커 없이 독립 행으로 렌더링됐다. 부수 결함: 10분 넘는 정상 장시간 에이전트 턴도 TTL이 앵커를 버려 응답이 standalone. Claude Stop hook은 best-effort(~18%)라 유실이 지배적 실패 모드인데, Node 데몬은 Stop 시점 타임라인 백스캔(`turnOpen = lastStart.ts > lastCompletionTs`)이라 자기치유되고 Swift만 드리프트했다.
2. **TASK 헤더 프리픽스 폴백**: hook `session_start` payload에 `project_name`이 없으면(직접 `claude` 설치 형태) `run.projectName`이 비어 task_start/task_milestone/projected 행 전부 무라벨 → 클라이언트가 agentType 폴백 프리픽스를 표시.

### 해결
- **`ChatStartTsQueue` → `ChatTurnAnchorTracker`** (Node Stop-time 백스캔 파리티): 세션당 open turn은 최신 chat_start 1개뿐. `noteChatStart`가 미청구 앵커를 대체(유실 Stop은 다음 프롬프트에서 자기치유), `claimOpenTurn`이 첫 Stop에 앵커를 넘기고 턴을 닫음(중복/지연 Stop은 nil → response-only 폴백만), TTL 제거(장시간 턴 앵커 보존). 트레이드오프(Node와 동일): 이전 턴 Stop 전에 후속 프롬프트가 오는 진짜 인터리브에선 늦은 Stop이 새 턴 앵커를 가져감 — 관찰 턴은 세션당 직렬이고 유실이 압도적이라 수용, 트래커 주석+테스트로 명문화.
- session_end/stale-eviction의 미완 턴 강제 close 판정은 `hasOpenTurn`(구 `depth>0`), codex tool_exec 중간 스탬프는 `peekOpenTurn`(비소비, Stop이 claim 소유).
- **projectName 보강 2단**: DaemonServer가 컬렉터 호출 전 `apmeEnrichedHookPayload`로 payload에 project_name 주입(`pushedSessionsById` 우선 → `ProjectNameResolver` cwd 폴백) + 컬렉터 프롬프트 경로에서 빈 `run.projectName`을 store 백필(빈 값일 때만 — 덮어쓰기 금지). task_start/milestone은 emit 시 store에서 run을 fresh 조회하므로 지연 승격 헤더도 라벨을 받는다.

### 검증
macOS XCTest 전체 스위트 green — 신규: 앵커 트래커 7건(유실 Stop 재동기화 THE-regression·중복 Stop 억제·no-TTL·세션 격리·peek 비소비·clear)·projectName 백필/비덮어쓰기 1건. FIFO 시맨틱을 단정하던 구 큐 테스트 9건은 새 시맨틱 테스트로 대체. macOS 앱 타깃 빌드 성공.

---
