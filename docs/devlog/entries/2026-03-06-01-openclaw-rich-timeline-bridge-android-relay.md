# 2026-03-06 — OpenClaw Rich Timeline: Bridge → Android Relay

### 문제
Android Dashboard의 OpenClaw 타임라인이 `StateTimelineGenerator`의 단순 상태 전환 이벤트만 표시 ("Prompt sent" / "Response received (5m 32s)"). Plugin은 이미 `log-stream.ts` + `gateway-client.ts`에서 풍부한 데이터(프롬프트 텍스트, 모델명+토큰, tool command, 응답 스니펫)를 확보하고 있지만, Android로 전달하는 채널이 없음.

### 해결
`shared/src/timeline.ts`에 `TimelineEntry` 타입 + `parseLogLine()` 공유 함수 추출 (plugin에서 이동). Bridge OpenClaw 모드에서:
- `BridgeTimelineStore` (200-entry buffer) + `BridgeLogStream` (`openclaw logs --follow --json` 파서) 초기화
- OpenClaw adapter에 chat tracking 추가 (prompt/duration/tool count) → rich `chat_start`/`chat_end`/`tool_request`/`tool_resolved`/`chat_response`/`error` 이벤트 생성
- `timeline_event` (실시간) + `timeline_history` (클라이언트 연결 시 배치) BridgeEvent로 WS broadcast
- Android `StateTimelineGenerator`에 `receivingBridgeTimeline` 플래그 추가 — bridge timeline 수신 시 로컬 생성 억제, disconnect 시 자동 fallback

### 핵심 설계 결정
- **타입 공유**: `parseLogLine()`을 plugin→shared로 이동하여 bridge/plugin 양쪽에서 동일 파서 사용. Plugin의 `TimelineEntry`는 shared 타입 + `'now_marker'`(display-only) 확장
- **억제 패턴**: Android가 rich timeline 수신 시 로컬 StateTimelineGenerator를 완전 억제 (혼합하면 중복 발생). disconnect 시 자동 fallback으로 graceful degradation
- **3곳 dedup**: (1) adapter tool_request → logStream.trackToolRequest (2) logStream 내부 5s 윈도우 (3) Android TimelineStore distinctBy

---
