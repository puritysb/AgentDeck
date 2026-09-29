# 2026-07-25 — 관찰 Claude AskUserQuestion 구조화 lifecycle + display-only 선택지

직접 실행한 Claude Code의 `AskUserQuestion` 대기를 generic
`permission_prompt`로만 표시하고, 경우에 따라 다시 `processing`처럼 보이던 경로를
실데이터로 재검증해 고쳤다. hook 순서는 `PreToolUse(AskUserQuestion)` → 약 6초 뒤
`Notification(permission_prompt)` → 사용자 응답 뒤 `PostToolUse`였고, 실제 17분
대기 중 JSONL의 완성 레코드는 멈췄지만 파일 mtime은 뒤늦게 전진했다. 기존 Node
overlay는 질문/선택지가 든 PreToolUse를 버리고 generic Notification만 저장한 뒤,
display-only prompt의 mtime-recency ESC 복구 규칙을 모든 prompt에 공통 적용해
구조적인 완료 신호 없이 overlay를 해제할 수 있었다.

Node/Swift daemon 모두 `AskUserQuestion` PreToolUse의 첫 유효 question group과 실제
option label을 `awaiting_option`으로 올리고, 필수 `tool_use_id`를 daemon 내부에만
보관한다. 같은 id의 `PostToolUse` 또는 새로 설치하는 `PostToolUseFailure`에서만
해제하며, 무관한 병렬 tool hook과 raw transcript mtime은 이 option lifecycle을
건드리지 않는다. 뒤따르는 generic permission Notification도 구조화 overlay를
덮어쓰지 않는다. user prompt/stop/session start/end는 authoritative boundary라
orphan overlay를 정리한다. 일반 permission Notification의 기존 mtime 기반 ESC
stuck 복구는 그대로 유지했다. 여러 question group을 하나의 wire index로 위험하게
평탄화하지 않고 첫 유효 group만 표시하며, `multiSelect: true`일 때만 해당
promptType을 표기한다.

관찰 세션에는 PTY 응답 채널이 없으므로 `tool_use_id`를 `requestId`로 가장하지
않는다. sessions_list에는 실제 question/options를 싣되 shared D200H, Stream Deck,
Apple HUD, Android tablet/e-ink에서 선택지를 비동작형으로 렌더하고
“Choose/answer in terminal” 안내를 붙였다. Apple/Android `SessionInfo` decoder도
per-session `options`/`promptType`/`navigable`/`controlMode`를 받아 동일 계약을
지키도록 맞췄다.

검증: 전체 Vitest 111 files/1,893 tests, workspace TypeScript typecheck, Android
`EinkAttentionPanelTest`와 Debug Kotlin 컴파일, macOS
`xcodebuild build-for-testing`이 통과했다. 새 Swift parser/lifecycle 테스트는
테스트 번들까지 컴파일·링크됐으나 이 Mac의 LaunchServices가 테스트 runner를
`prevent launch`(-10699)로 막아 XCTest 실행 단계만 환경상 수행되지 못했다.
