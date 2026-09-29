# 2026-07-31 (2) — "재생이 안 된다": openclaw-gateway는 브리지가 없는 세션이었다

밤새 작업의 마지막 조각. 실사용 PTT가 전사→전달까지 표시되는데 스피커
응답이 나오지 않았다. 로그 추적으로 두 겹의 단절을 찾았다.

**전달이 사실은 안 되고 있었다.** `finishVoiceCapture`의 managed 분기는
`session_command`→`focusRelay`로 보내는데, `openclaw-gateway` 세션은
브리지 포트가 없어 릴레이가 연결할 곳이 없고 명령은 조용히 사라진다 —
그런데 코드는 무조건 `delivered=true`를 보고했다. wake-word 경로가
이미 아는 답(`gatewayAdapter.handleCommand({type:'send_prompt'})`)으로
음성 전달과 `session_command` 일반 경로 양쪽에 gateway 특례를 추가하고,
delivered를 실제 결과로 보고하게 했다.

**응답 트리거가 매칭될 수 없었다.** 스피커 응답은
`bridgeTimeline.onEntry`의 `chat_response`가 트리거인데, Gateway
어댑터의 타임라인 행은 sessionId 없이 나와 arming
키('openclaw-gateway')와 영원히 못 만난다(timeline.json에 openclaw 행
0개가 증거). `enrichGatewayTimelineEntry`가 `sessionId ??
'openclaw-gateway'`를 스탬프하도록 했다.

검증: 실캡처 PCM을 `sessionId=openclaw-gateway`로 재주입 → OpenClaw
실응답 → `reply ready for openclaw-gateway -> 1 board(s)` → `spoke
reply (157838B, 30 chars)` — 캡처→업로드→전사→게이트웨이 전달→응답
합성→WS 스트리밍→스피커 재생, 전 구간 최초 완주. vitest 1497 green.

---
