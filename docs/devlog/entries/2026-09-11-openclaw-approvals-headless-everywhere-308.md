# 2026-09-11 — 이 호스트에선 어떤 클라이언트도 exec 승인을 못 띄운다 (#308 검증 불가의 이유)

유령 PERM 수정(7c7dbe2a)의 실기 검증엔 실제 exec 승인이 하나 필요하다. 오너 허가를 받고 여섯 가지
경로로 만들어 보았고 전부 실패했다. 실패의 형태가 같아서 Gateway 번들을 읽었다.

### 거부 지점

`bash-tools-*.mjs`: `if (policyRequiresAsk && params.nonInteractiveApproval) return denyHeadlessApproval();`
`embedded-agent.runtime-*.mjs`: `nonInteractiveApproval = Boolean(permissionToolPolicy && execMode !== "full")`,
`EXEC_MODE_BY_PERMISSION_MODE = {read-only: deny, guarded: ask, workspace: auto, full: full}`.
세션 실행에 `full` 이 아닌 permissionMode 가 붙으면 승인 요청은 프롬프트가 아니라 **즉시 거부**다 —
`guarded` 의 `ask` 조차. 우리 `connect` 프레임의 `caps`/`mode` 와는 무관하므로 AgentDeck 이 승인
능력을 선언하는 식의 수정은 아무 효과가 없다.

### 시도 목록 (호스트 정책은 마지막 두 번을 빼고 원복 확인)

| 채널 | 정책 | 결과 |
|---|---|---|
| `openclaw agent -m`(headless) | full/off | 실행됨, 승인 없음 |
| 같은 것 + `/exec ask=on-miss` | full/on-miss | 실행됨 — `full` 이면 `ask` 무의미 |
| 같은 것 | allowlist/on-miss | **거부** `Headless runs cannot wait for interactive exec approval` |
| 데몬 WS `send_prompt` → 어댑터 `chat.send` + 메시지 지시 | full/off | 같은 거부 |
| pty 로 `openclaw tui`, 기존 세션 | full/off | 같은 거부 |
| pty 로 `openclaw tui`, **완전히 새 세션 키** | full/off | **같은 거부** |

TUI 는 Gateway 자신의 대화형 클라이언트인데 새 세션에서도 headless 다. `openclaw.json`·에이전트
(`agents list --json`)·세션 어디에도 `permissionMode` 가 없다 → `openclaw@2026.9.3` 런타임이 모든
실행에 non-full 모드를 기본 배정한다. 9/9 의 승인은 그 이전 동작이다.

### 함께 확정된 것

- 9/9 유령 PERM 의 트리거는 `tools.exec.strictInlineEval: true`(`openclaw.json`) — inline-eval 은
  허용목록과 무관하게 승인 필요. 이번에도 판정은 "승인 필요"까지 갔고, 그 다음이 거부였다.
- 정책을 `allowlist/on-miss` 로 바꾸는 실험은 창이 열린 동안 실제 cron/heartbeat 의 exec 을
  **거부**시킨다(`askFallback=deny`). 두 번 열었고 원복을 확인했다.
- 4번째 시도의 프로브 메시지 하나가 메인 채팅 세션(`agent:main:main`)에 남아 있다.
- 승인 표면은 둘이다 — `plugin.approval.*` 는 #309 로 렌더링을 붙였다.

### 결론

#308 은 AgentDeck 쪽에서 더 할 것이 없다. OpenClaw 가 다시 프롬프트를 내면(다음 릴리스, 혹은
에이전트에 명시적 `permissionMode: full`) #308 코멘트의 5단계가 그대로 검증 절차다.
