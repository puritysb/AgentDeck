# 2026-07-12 — Observed PreToolUse 게이트: `auto` 권한모드 false attention 수정

### 문제
사용자가 auto 권한모드로 observed Claude 세션(이 대화 자체 포함)을 쓰는 동안, 실제로 승인을 물은 적 없는 `git add`/`git -C`/`grep`/`Write` 등 호출마다 디바이스에 "Allow Bash: …?" attention이 뜨고 첫 호출마다 ~25초씩 멈췄다.

### 원인
당일 앞서 구축한 PreToolUse 게이트([[observed-steering-hook-rpc-ladder]] 참조)의 모드 게이트(`shouldGate`/`shouldGatePreToolUse`)가 `auto`를 `default` 브랜치("Claude may prompt → gate")로 분류했다. 그러나 auto 모드는 정책 엔진이 세션 내부에서 자동승인하며 그 결정이 settings 허용리스트 파일에 남지 않는다 — 룰 예측기가 이를 볼 수 없어 `.none`("prompt-prone, no rule match") 판정 → hold. `~/.agentdeck/swift-daemon.log`에서 같은 세션의 `git add`/`git -C`/`grep -rn`/`Write` 호출이 정확히 25초 뒤 "learned auto-approved signature"로 릴리즈되는 패턴을 확인해 라이브로 재현.

### 해결
`auto`를 `bypassPermissions`/`dontAsk`와 동일한 no-gate 케이스로 이동(Node `bridge/src/awaiting-overlay.ts` + Swift `DaemonServer.shouldGate`). auto 모드에서 드물게 뜨는 진짜 프롬프트는 이미 Notification `permission_prompt` 오버레이(display-only 경로)가 커버하므로 기능 손실 없음.

### 검증
- vitest `awaiting-overlay.test.ts` + `observed-steering.test.ts` 통과.
- XCTest `DeviceApprovalGateTests`(macOS) — TEST SUCCEEDED.
- 전체 vitest 중 `d200h-observed.test.ts` 4건 실패는 동시 세션이 작업 중이던 `shared/src/d200h-layout.ts` 등 in-flight 변경 때문으로, stash 후 재확인해 이 수정과 무관함을 검증.
