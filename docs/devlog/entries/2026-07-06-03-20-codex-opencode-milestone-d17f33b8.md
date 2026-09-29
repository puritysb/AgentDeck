# 2026-07-06 — 라운드 20: 관측 Codex/OpenCode 타임라인 에이전트 패리티 + 디바이스 milestone 정렬 (`d17f33b8`)

### 배경
라운드 19로 Claude 세션 타임라인(프롬프트→응답 턴)은 깔끔해졌지만, 사용자 지적: **OpenCode 기록이 타임라인에 전혀 안 보임**. 조사 결과 사용자는 `opencode`를 standalone으로 실행 중(3 프로세스, `agentdeck opencode` 아님)이었고, OpenCode는 lifecycle hook이 없으며 standalone TUI는 TCP 리스너도 없어(SSE attach 불가) **관측 경로 자체가 부재**. 직접 `codex`도 마찬가지: 훅은 데몬에 POST되지만 `/hooks/` 핸들러가 Claude 전용(eventMap PascalCase만, openRun `agentType:'claude-code'` 하드코딩, chat_start/stop 게이트가 Claude 이름만) — `codex_*`는 모든 게이트를 통과 못해 **타임라인 0행 + APME ingestHook no-op**. Swift 데몬은 codex 패리티 있음(appendCodexChatStart/End); Node만 뒤처짐.

### 해결 — 훅-우선 원칙으로 전 에이전트 동일 턴 패턴
- **데몬 일반화** (`classifyObservedHookEvent`, daemon-server.ts): `codex_*`/`opencode_*`(+미래 `antigravity_*`) → agent-중립 `boundary` + `agentType`으로 분류, Claude 훅과 **단일 파이프라인** 공유(openRun 올바른 agentType, prompt 실린 chat_start, chat_response/chat_end 완결). `codex_turn_complete`→stop 매핑(open-turn 가드가 중복 완결 흡수). 프롬프트 추출 체인 `prompt`→`message.content`→`user_prompt`. **Response-only close**(Swift 패리티): 프롬프트 훅 놓친 턴도 응답 텍스트 있으면 chat_response 방출(raw-equality dedup 가드).
- **Codex 응답 텍스트 = rollout tail** (`codex-rollout-response.ts`): codex_stop payload엔 응답이 거의 안 실림(탐사 확인). `~/.codex/sessions/<y>/<m>/<d>/rollout-*-<sessionId>.jsonl` tail에서 `task_complete.last_agent_message`(권위) → 최신 `agent_message` 폴백. 파일명에 session uuid 내장이라 역방향 탐색 가능(30 day-dir 바운드, 자정 넘김 커버).
- **OpenCode 관측 = 플러그인 훅** (`hooks/src/opencode-install.ts` → `~/.config/opencode/plugins/agentdeck.js`): OpenCode 공식 플러그인 API의 `event` 훅으로 `opencode_session_start/user_prompt_submit/tool_start/tool_end/stop` POST. messageID→role 맵으로 user 텍스트 파트(프롬프트)와 assistant 파트(응답) 분리, `session.idle`에 `last_assistant_message` 동봉. **AGENTDECK_PORT 감지 시 self-disable**(managed 세션은 SSE 어댑터가 이미 풍부한 스트림 인제스트 — 중복 카운트 방지). `agentdeck opencode`/`daemon install`이 설치, hook uninstall이 제거.
- **Managed OpenCode 어댑터 턴 셰이프**: chat_start가 "Processing · proj" 고정이었음 → 실제 유저 프롬프트 upsert(Claude 패턴). user 텍스트 파트가 accumulatedResponse를 덮어 유저 말이 chat_response로 에코되던 버그 수정. chat_response XOR chat_end(3행 파편화 제거) + startedAt/endedAt 스탬프.
- **Swift 데몬 가드**: `opencode_*` 무시(안 하면 generic Claude 폴백이 OpenCode 세션마다 유령 claude 세션 행 합성 + Claude-keyed ApmeCollector 오귀속). Swift 쪽 OpenCode 타임라인 패리티는 후속 과제로 명시.
- **디바이스 milestone 정렬**: InkDeck 티커 milestone 필터에 `chat_response` 추가(chat_end dedup 이후 응답 있는 턴은 chat_response가 완결 행 — 없으면 "질문은 보이는데 답은 영영 안 보임"). IPS10 세션카드 body를 2-pass로: milestone 우선(chat_start=진행 중 질문, chat_response=완료 답) → 없으면 기존 raw 최신행 폴백(tool-only 이력 공백 방지). Android e-ink는 이미 turn-merge 완료 행 표시라 무수정.

### 검증
- vitest 1226 전체 green(신규: classify 6, rollout reader 4, 어댑터 턴셰이프 5, 플러그인 계약/설치 12) + `tsc` + macOS xcodebuild green + inkdeck/ips10 펌웨어 빌드 SUCCESS + InkDeck WiFi OTA 배포(1.5MB/1574 chunks).
- **라이브 E2E**: 재시작한 데몬에 합성 `codex_*`/`opencode_*` 턴 POST → `task_start`+`chat_start`(prompt)+`chat_response`(응답, startedAt/endedAt/taskId) 정확히 랜딩. **실제 standalone `opencode run` 실행** → 플러그인이 실프롬프트/실응답 캡처해 타임라인에 Claude와 동일 턴 패턴으로 표시 확인.

### 남긴 것 / 주의
- Antigravity: 훅 설치 수단 없음(IDE가 lifecycle hook 미노출). 데몬은 `antigravity_*` 수신 준비 완료(installer만 생기면 무변경 패리티); transcript 폴링 기반 턴 합성은 파서가 휴리스틱이라 실기 테스트 가능해질 때까지 보류.
- 데몬 재시작 중 9120 teardown과 겹쳐 **9124로 fallback** 기동됨(포트 유연성 정상 동작) — 클라이언트는 daemon.json 재해석으로 자동 추종. 다음 재시작 시 9120 복귀.
- 검증용 합성 e2e-* 행이 데몬 인메모리 타임라인에 잠시 남음(링 캡으로 자연 소멸).
- 데몬 기동 직후(~40s) 최초 훅 배치 1회가 무손실 응답(received:true)에도 타임라인 미랜딩한 transient 관찰 — 동일 payload 재현 불가(이후 결정론적 성공). 재발 시 startup 초기화 순서 조사.
