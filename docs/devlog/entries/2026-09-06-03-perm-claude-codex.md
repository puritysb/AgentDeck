# 2026-09-06 — PERM 후속 라이브 감사: 내부 Claude 종료 잡음과 Codex 표시·설치 누락

PR #282의 두 TODO를 실제 CLI로 다시 계측했다. Claude Code **2.1.261**의 일반 Agent 호출은
추가 마커의 Start/Stop, 설치된 HTTP 훅, 데몬 tracker, APME `sample_events`까지 동일 자식 ID로
모두 도달했다(완료 duration 2,056ms). 반면 TUI의 내부 prompt-suggestion fork는 Agent를
시작하지 않고도 `SubagentStop`를 보냈다. 두 실측 payload는 `agent_type: ""`, 응답
`wait for it and reply PARENT_BACKGROUND_OK` / `<no suggestion>`였다. 설치 바이너리의
`forkAgentQuery` 경로도 Start 호출 없이 일반 query loop의 Stop을 타는 것을 확인했다.
따라서 과거 started 7 / completed 221을 수신 유실률로 해석한 것은 잘못이다. 보조 fork와
단방향 `TaskCompleted`가 분모에 섞였고, 현재 7일 집계도 started 24 / completed 363이었다.
과거 원시 payload가 없으므로 전부 같은 원인이라고 단정하거나 이력을 backfill하지 않는다.

양 데몬은 **명시적으로 빈 agent_type + 현재 활성 자식 없음**인 Claude Stop을 자식 전용
경로에서 소비하되 타임라인·센서스·APME에는 쓰지 않는다. 타입이 있는 orphan Stop,
필드가 아예 없는 legacy payload, 이미 시작한 자식은 보존한다. 별도 named/background
Agent 실측은 새 session_id의 SessionStart/Stop을 사용했다. 부모 링크를 추측하지 않는다.

Codex는 설정 파일만 보고 완료라고 할 수 없었다. 설치된 **0.149.0**의 `hooks/list`에서
PermissionRequest는 `untrusted`, Interrupt는 목록에 없었다. 임시 설치한 **0.151.0**은 둘 다
인식하며 Interrupt의 기존 timeout 5를 상한 3초로 clamp했다. AgentDeck 명령 두 개만
Codex의 `/hooks`에서 검토·신뢰 처리했고, 전역 CLI나 모델 설정은 교체하지 않았다.
설정된 gpt-6-astra가 이 CLI들을 거절하므로 라이브 승인 실험에만 gpt-5.5를 명시했다.

실제 `on-request` + `read-only` TUI에서 부작용 없는 printf 명령 세 개를 승인 / Esc 거부 /
Ctrl+C 취소했다. 같은 세션의 데크 `sessions_list`에서 세 번 모두 awaiting_permission의
질문을 확인했고, 이후 question 없는 processing → idle을 확인했다. 운영 APME turn의
end_source는 순서대로 `stop`, `interrupted`, `interrupted`였다. 물리 화면 픽셀 검증은 아니며
실제 기기들이 받는 WebSocket 프레임을 관측한 것이다.

추가 수정: Swift 설치기에 빠져 있던 PermissionRequest/Interrupt와 3초 제한을 추가하고,
Swift의 daemon-restart 후 첫 PermissionRequest도 tombstone 없는 mid-turn 복구 경로를 탄다.
또한 같은 프로젝트의 processing Codex 행이 승인 대기 행을 가리는 **실제 fold 결함**을
발견했다(종료된 실험 세션 두 개가 processing으로 남은 동안 PERM이 안 보임). shared fold와
Swift daemon/preview가 awaiting 멤버를 우선하고 그 멤버의 ID·질문·tool을 함께 보존한다.

검증: 최종 전체 Vitest **256파일 4,003개 통과**. 미리보기 SYNC-HASH gate도 Swift 포트와
일치하도록 갱신했다. 최종 macOS XCTest 160개 실행(159 통과, 환경변수로 opt-in하는
스냅샷 생성 1 skip). 실제 마커를 수정된 tracker에 재생해 내부 Stop 5개가 소비되고 정상
시작/완료 1쌍이 보존됨을 확인했으며, 캡처한 Codex 행을 재생해 processing 형제가 있어도
승인 질문이 유지됨을 검증했다. workspace TypeScript와 docs check 통과. 기존 Ollama 미커밋 변경은 보존했으며 이 수정의
초기 감사 단계에서는 운영 데몬 재시작·앱 배포를 하지 않았다. 비공개 마커·WS·CLI 계측 결과는 저장소 밖에 보관한다.

후속 실행 설정 요청으로 `pnpm build` 후 CLI를 빌드 `91ccd5dd0dbe`로 재시작하고,
`/opt/homebrew/bin/agentdeck`을 현재 checkout의 `bridge/dist/cli.js`에 연결했다.
Codex 관리 훅도 갱신했다. Swift는 현재 팀의 Release 배포 인증서가 없어 개발 서명 Debug
빌드를 `/Applications/AgentDeck.app`에 설치·실행했다(기존 앱은 별도 백업).
CLI 중지 시 Swift PID의 `/health` 정상 응답을 9121에서 확인했고, 이후 9120 복귀와
CLI 재기동 시 stand-down 및 앱의 클라이언트 재연결을 확인했다. 최종 운영은 CLI가
9120을 소유하고 수정 Swift 앱이 연결된 상태다. 이는 단독 서버 기동·전환 검증이며,
Swift 단독에서 실제 CLI 승인 요청과 PERM 표시·해제를 끝까지 재실측한 것은 아니다.

추가 Swift 단독 실측도 완료했다. CLI 데몬을 중지한 상태에서 수정 앱 PID 96309가
실제 Codex 0.151.0 (`gpt-5.5`, `on-request`, `read-only`)의 PermissionRequest를 받아
네이티브 화면에 `⚠ PERM`과 `printf SWIFT_PERM_*` 질문을 표시했다. 승인 후
PostToolUse는 질문 없는 processing → idle, Esc 거부와 Ctrl+C는 실제 Interrupt 수신 후
질문 없는 idle로 돌아갔다. 데크 WS도 동일 전이를 확인했다. Swift가 9121에서 9120으로
복귀하던 구간의 첫 거부는 앱 화면·훅 로그로 확인하고, 9120에서 한 번 더 반복해 WS까지
확인했다. Claude 2.1.261의 실제 Agent 한 개도 마커 Start/Stop와 Swift 수신이 일치했고
센서스가 active 1 / peak 1 / completed 0 → active 0 / peak 1 / completed 1로 전이했다.
추가 코드 결함은 발견하지 않았다. 반복 PERM은 연결된 T-Embed 알림음도 실제로 울렸으며
사용자 제보 후 승인 실험 종료·PERM 해제를 확인했다. 다음 라이브 승인 검증은 기기 알림
영향을 먼저 안내하고 필요한 경우 격리한다. 테스트 CLI·관측 프로세스를 종료하고
운영 CLI PID 31283 / build 91ccd5dd0dbe / 9120과 앱 클라이언트 연결을 복구했다.
원시 WS·마커와 요약은 저장소 밖 `swift-live-summary.json` 등에 보관했다.

---
