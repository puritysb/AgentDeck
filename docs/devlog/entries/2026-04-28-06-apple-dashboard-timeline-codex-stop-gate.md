# 2026-04-28 — Apple dashboard timeline 중복 행 + Codex stop-gate 회귀 체인

### 문제

사용자가 macOS Dashboard timeline 에 같은 응답이 두 줄씩 표시된다고 보고. 초기 진단은 Node bridge `wireClaudeCodeTimeline` 의 Stop hook + PTY fallback dual-emit race (Stop 이 fallback 보다 1.5s+ 늦으면 같은 turn 이 두 번 emit) 로 잡았으나, 실제 사용자 환경은 `agentdeck claude` 를 안 돌리고 Apple in-process Swift daemon 이 직접 hook 을 받는 구조였다. 같은 증상의 다른 root cause: `appendClaudeCodeChatEnd` 가 `chat_response` 와 `chat_end` 를 emit 하는데 둘 다 응답 텍스트 prefix 를 `raw` 로 사용 → UI 의 chat_end 행이 `isChatEnd` opacity 0.4–0.6 으로 dim 처리되어 같은 내용이 한 번은 밝게, 한 번은 회색으로 표시되어 시각적 중복이었다.

### 해결

Stop-gate 자동 리뷰가 fix 의 회귀를 단계별로 잡아내 총 8 차 반복:

1. **Node bridge 측 race fix** — `wireClaudeCodeTimeline` Stop 핸들러에 `wasPending` 가드 추가 (fallback 이 이미 emit 했으면 skip), `chat_response` 를 `isRepetitiveEntry` 화이트리스트에 추가, exact dedup 윈도우 5→8s 확대 (`shared/src/timeline.ts`, Apple `DaemonTimelineStore.swift` 양쪽). 회귀 방지 vitest 2 케이스.
2. **Apple chat_end 메타데이터화** — `claudeChatStartTsBySession` in-memory map 추가, `appendClaudeCodeChatStart` 끝에 ts 기록, `appendClaudeCodeChatEnd` 의 `endRaw` 를 응답 prefix 가 아닌 `Completed · ${duration}s` 로.
3. **Codex 1차 stop-gate**: `Completed · Ns` 만 쓰면 같은 round duration 두 빠른 turn 이 8s 윈도우에서 collapse → topic hint 라벨 추가. Swift 포트 `extractTopicHint(from:)` (`shared/src/timeline-summarizer.ts:18` 동등). 응답 → prompt → "Completed" fallback.
4. **Codex 2차 stop-gate**: full prompt 보관 + cleanup 누락 → bounded topic prefix (≤80 char) 만 저장 (`claudeLastPromptTopicBySession`), chat_end / `case "session_end"` / `evictStaleHookSessions` 3 군데 cleanup 추가.
5. **Codex 3차 stop-gate**: 비정상 종료 (Stop hook 미발사) + 새 turn 의 unparseable prompt 일 때 `appendClaudeCodeChatStart` 의 `guard !prompt.isEmpty` early-return 이 cleanup 을 우회 → 함수 시작부에 unconditional invalidate. 4-site cleanup 패턴 완성.
6. **시각 중복 잔존**: chat_end raw 가 topic hint (응답 첫 줄 truncate) 라 chat_response 의 첫 줄과 첫 80 chars 가 동일 → 시각적 중복 그대로. `Completed · ${duration}s · ${topic}` prefix 로 시각 분리.
7. **UX 최종 정리**: 사용자가 "한 줄 더 나오는 현상" 으로 felt → `TimelineStripView.grouped` 에서 claude-code chat_end 를 filter out. daemon 은 그대로 emit (Pixoo / D200H / plugin / APME 가 turn 종료 marker 로 사용) 하지만 dashboard timeline panel 에는 한 turn = 한 row.
8. **빈 timeline title 정렬**: `HStack(alignment: .top, spacing: 0)` 으로 변경 — empty timeline 컬럼이 detail pane 의 vertical center 로 끌려가서 "TIMELINE" 타이틀이 가운데 떠 보이던 현상 해소.

### 핵심 설계 결정

- **이중 root cause**: 같은 사용자 증상이지만 Node bridge 와 Apple daemon 모두 dual-emit 구조를 갖고 있어 양쪽 다 수정 필요했다. Node 는 race fix, Apple 은 chat_end 라벨 형식 + UI hide.
- **bounded value + 4-site cleanup 패턴**: per-session in-memory cache 도입 시 (1) bounded value (≤80 char topic 만), (2) 새 turn 진입 시점 upfront invalidate, (3) turn 정상 종료 cleanup, (4) session_end cleanup, (5) TTL eviction cleanup — 5 군데 모두 챙겨야 stale leak 없음.
- **chat_end UI hide vs daemon emit 분리**: chat_end 는 turn 종료의 canonical signal 이지만 Apple dashboard timeline panel 에서는 chat_response 가 이미 결론을 표시하므로 redundant. UI 단 filter 만 적용하고 daemon emit 은 유지 (다른 surface 가 사용).

### 검증

- vitest 1015/1015 통과 (timeline-integration 24/24, 새 race 회귀 2 건 포함)
- macOS scheme `xcodebuild build` 성공 (각 fix 단계마다 재빌드)
- daemon 재시작 후 `~/.agentdeck/timeline.json` 직접 검증 — chat_end raw 가 `Completed · Ns · topic` 형식, chat_response 와 다른 raw, dashboard 에선 hidden
- Codex stop-gate 통과 (3 단계 회귀 각각 별도 review 로 catch)

---
