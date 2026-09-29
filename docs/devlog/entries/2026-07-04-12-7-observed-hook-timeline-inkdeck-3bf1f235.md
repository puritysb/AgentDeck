# 2026-07-04 — 라운드 7: 타임라인 인제스트 복구(observed hook→timeline) + InkDeck 랩 버그 (커밋 3bf1f235)

- **"로그가 00:28 이후 안 쌓임" 근본 원인**: 타임라인 chat/tool 행은 **managed 세션 브리지의 릴레이로만** 생성됐음. 00:28 = 마지막 managed codex 세션 종료 시각; 이후 사용자의 모든 작업은 observed(터미널 직접 실행 + hook만)라 행이 0개. 로그 시스템 고장이 아니라 **observed 경로에 방출 지점이 아예 없던 구조적 갭**. fix: 데몬 훅 엔드포인트(`/hooks/:event`)가 UserPromptSubmit→chat_start(프롬프트), PreToolUse→tool_exec(툴+입력 힌트)를 직접 방출(session_id + cwd basename 프로젝트명). chat_end는 의도적 미방출(훅엔 응답 텍스트가 없어 "Completed" 빈 행 = 파편화). **라이브 검증**: 재시작 수 초 뒤 현 세션의 Bash 훅이 타임라인에 등장.
- 부수 관찰: "프로젝트명 '/' + 빈 JSON" 행들은 어제 managed codex PTY가 남긴 것(rollout tool JSON이 chat_response로 기록, cwd '/' 어트리뷰션) — 링에서 자연 퇴출; InkDeck 티커는 `{`/`[` 시작 raw를 스킵.
- InkDeck 랩 버그 2건: 공백-전용 백오프가 하이픈 긴 단어("Hello-world-claude-opus…")에서 첫 줄을 한 글자("H")까지 축소 → `drawWrapped2`(단어 경계 우선 + mid-word 하드브레이크 + **두 줄 동일 폰트**). 티커도 classic 강하 제거(9pt 고정).
