# 2026-07-02 — 타임라인 이벤트 단위 정합성: OpenClaw 중복 행 제거 + APME 이중 인제스트 차단 + orphan task reaper

### 문제
"타임라인에 태스크 진행/완료가 완결성 있게 안 보이고 OpenClaw 이벤트가 중복된다"는 리포트. 라이브 `~/.agentdeck/timeline.json` 조사로 확정한 사실: OpenClaw 턴 종료 시 `chat_response`와 `chat_end`가 1~13ms 간격으로 **같은 응답 `detail`을 실은 2행**으로 기록됨(예: ts `…314998`/`…315011`). 코드 원인 4계열:
1. **OpenClaw 어댑터 이중 emit** — `chat_response`(APME 캡처용으로 추가됨) + 기존 `chat_end`가 둘 다 emit. Claude 경로는 이미 상호배타(`emitCompletion`, response>20자면 chat_end 생략)로 고쳐졌지만 OpenClaw엔 미적용된 회귀.
2. **APME 이중 인제스트** — OpenCode처럼 `setApmeSession`으로 직접 span을 넣는 어댑터의 타임라인 행을 `wireAgentApme`가 또 span으로 변환 → 한 프롬프트에 turn_start 2~3회(phantom 빈 턴, turn_index 밀림), tool 스팬 2배(counter-based dedupCore라 storage dedup 무력). upsert 이벤트(chat_start topic 힌트, LLM 요약)도 span으로 재변환되고 있었음.
3. **turn_start 에코** — OpenClaw `chat.send` span과 gateway `session.message` role=user 에코가 같은 프롬프트로 각각 turn_start. Swift 데몬도 동일(chat `prompt` echo와 session.message가 모두 `model_call`→`user_prompt_submit`; 스토어 dedup과 무관하게 APME 공급은 무조건 실행).
4. **Swift log-tail replay 중복** — `parseLogLine`이 ts를 **파싱 시각**으로 재스탬프 → 재연결마다 재fetch된 80줄이 새 ts로 8s dedup을 통과해 중복 누적. + Node 데몬에는 Swift `computeOrphanTaskEnds` 같은 orphan task reaper가 없어 데몬이 태스크 중간에 죽으면 task_start 고아가 영구 in-flight 스핀.

### 해결
- **`bridge/src/adapters/openclaw.ts`** — chat final에서 `chat_response`(응답 있음)/`chat_end`(무응답) 상호배타 emit. `chat_response`에 `automated` 플래그 승계. async LLM 요약 upsert 타깃을 chat_end→chat_response로 변경, automated 턴은 enrichment 스킵(저장단에서 low-signal drop된 행을 upsert 폴스루가 부활시키는 것 방지).
- **`bridge/src/index.ts` wireAgentApme** — upsert 이벤트는 span 변환 제외; `hasDirectApmeIngestion()`(openclaw/opencode 어댑터에 신설) true면 타임라인→span 변환 스킵(직접 인제스트가 단일 소스). `classifyAndEnqueueTurn`은 non-upsert chat_response에서 유지.
- **`bridge/src/apme/collector.ts` + Swift `ApmeCollector.swift`** — duplicate-open 가드: active turn이 같은 프롬프트 + toolCalls==0 + 응답 없음 + 15s 이내면 turn_start 무시(`DUPLICATE_TURN_OPEN_WINDOW_MS`). `ActiveTurn`에 `prompt`/`hasResponse` 추가, `setTurnResponse`가 hasResponse 마킹.
- **`bridge/src/timeline-store.ts` `reapOrphanTaskStarts()`** — Swift `computeOrphanTaskEnds` 미러. 데몬 시작 시 persisted 로드 후 고아 task_start에 합성 task_end(`"Interrupted · –"`, boundarySignal `interrupted`) — 실제 task_end가 늦게 오면 taskId merge로 대체됨. `daemon-server.ts` 로드 직후 호출.
- **Swift `OpenClawAdapter.requestInitialLogTail`** — 어댑터 수명 내 재생한 라인 seen-set(`replayedLogLines`, 4096 캡)으로 재연결 replay 중복 차단(ts 기반은 재스탬프 때문에 무효).
- docs/gateway-protocol.md의 Swift 어댑터 경로 표기 수정(Modules/→Gateway/).

### 검증
- vitest 전체 88 파일/1621 테스트 pass. 신규: `openclaw-timeline-completion.test.ts`(상호배타+automated+LLM upsert 타깃), `timeline-orphan-reaper.test.ts`, collector 에코 가드 2케이스. (참고: better-sqlite3 ABI 재빌드 필요했음 — Node 26 업그레이드 여파, 기존 메모리 패턴.)
- `xcodebuild AgentDeck_macOS` BUILD SUCCEEDED; XCTest 338개 중 실패 6개는 stash 대조로 전부 pre-existing(Timebox 글리프 색상 4 + idle-gap 타이밍) 확인.

---
