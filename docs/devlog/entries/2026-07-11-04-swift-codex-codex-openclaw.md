# 2026-07-11 — Swift 데몬 codex 세션 플랩 · Codex/OpenClaw 타임라인 응답·귀속 유실

### 문제
이 머신은 Node CLI 데몬이 반복 자체종료([[dev-machine-node-daemon-repeated-shutdown]])라 **Swift 인프로세스 데몬이 상시 9120 허브**다. Node의 `ps`/`lsof` 기반 observed 세션과 달리 Swift는 hook-TTL 휴리스틱만 있어 아래 결함이 Swift 허브에서만 발현됐다.
- **codex 세션 플랩**: companion-task용 공격적 TTL(post-terminal 60s / idle 90s)이 장수 인터랙티브 `codex` CLI에 그대로 적용되고, 부활은 `codex_session_start`/`codex_user_prompt_submit`만 허용 → 긴 thinking(무 hook 90s) 중 evict되면 이후 tool hook이 계속 와도 다음 프롬프트까지 세션이 사라짐. 로그상 한 스레드가 30초(sweep 주기)마다 반복 evict.
- **Codex/OpenClaw 응답 미표시**: OpenClaw는 Gateway가 응답을 flat `payload.response`가 아니라 `payload.message.content[].text` 구조로 옮겼는데 Swift 어댑터가 옛 필드만 프로빙 → `model_response` 전멸(라이브 timeline.json에서 0건 확인). Codex는 세션 플랩이 chat 큐(`startedAt` 앵커)와 세션 엔트리(projectName)를 지운 뒤 늦은 stop이 도착해 앵커/귀속 없는 응답 행이 되어 병합 실패.
- **prefix 혼재**: evict 후 방출된 codex 행이 projectName 없이 저장돼 클라 prefix가 `[Codex CLI]`로 fallback(`[AgentDeck]`와 뒤섞임).
- **Android만 "Connected/Prompt sent/Bash" 가짜 행**: Swift connect burst에 `timeline_history`가 없어 Android가 히스토리도 못 받고 `receivingBridgeTimeline` 억제 플래그도 안 켜져 로컬 StateTimelineGenerator가 iOS/macOS엔 없는 상태-파생 행을 계속 생성.

### 해결
- `DaemonServer.swift`: (a) terminal 기록이 있는 스레드가 새 턴을 열면 **interactive 승격**(`codexRegisterNewTurnSignal` — 재개=인터랙티브 시그니처, companion은 단일턴)해 post-terminal fast-evict 면제 + 30분 idle TTL. (b) evict 시 terminal ts를 **tombstone으로 보존** — tombstone/terminal 기록 없는 미지 세션의 `codex_tool_start/end`는 산 턴이 중간에 reap된 것이므로 부활 허용, 있으면 companion 잔여 콜백이라 차단. (c) codex 타임라인 projectName 해석 체인(세션엔트리→payload cwd→evict 생존 캐시). (d) connect burst에 `timeline_history`(getRecent 100) 추가.
- `OpenClawAdapter.swift`: Node `extractMessageText` static 미러(테스트 2건 포함) + delta 누적 fallback으로 model_response 복원; 행 projectName 기본값 "OpenClaw".
- `AgentState.kt`: Apple parity — `gatewayConnected==true`면 StateTimelineGenerator 억제.
- `TimelineStrip.kt`: prefix를 **projectName 단독**(`[AgentDeck]`)으로, agent tag는 project 없을 때만.

### 핵심 설계 결정
- **codex 플랩의 근본 = 샌드박스가 `ps`를 막아 Swift가 프로세스 생존을 못 봄**. Node는 프로세스 테이블로 grounding하지만 Swift는 hook 휴리스틱뿐이므로, "multi-turn 재개"를 companion↔interactive를 가르는 유일하게 신뢰 가능한 신호로 삼았다.
- **evict와 부활의 구분은 tombstone**: terminal 기록을 지우지 않고 evict를 넘겨 보존해야 "죽은 companion의 잔여 hook"과 "산 턴이 중간에 reap된 것"을 나눌 수 있다.
- **Swift connect burst는 Node bridge-core와 이벤트 파리티를 유지**해야 한다. Node에 있는 초기 이벤트가 Swift에 없으면 클라이언트 억제 로직이 영영 안 켜져 가짜 행이 샌다.
- **타임라인 prefix는 projectName 단독**(사용자 확정) — 브랜드 글리프가 이미 에이전트를 시각화하므로 텍스트 태그 병기는 중복.

### 검증
`xcodebuild AgentDeck_macOS Debug` BUILD SUCCEEDED, 대상 XCTest 80/80 (신규 extractMessageText 2건 포함) 0 failures, Android `compileDebugKotlin` + `testDebugUnitTest` 통과. 적용은 앱 재시작(옛 데몬 pid 1756은 구코드) 필요.

---
