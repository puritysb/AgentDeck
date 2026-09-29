# 2026-02-23 — False Idle from PTY Batch Echo & Permission Button Label Dedup

### 문제
1. **Permission 후 false idle**: Permission prompt(Yes/No/Always) 감지 직후, 같은 PTY batch의 후속 chunk에 user prompt echo(`❯ Review the commit log...`)가 포함. `IDLE_PROMPT` 매칭 → 300ms 후 idle 발출 → `AWAITING_PERMISSION` 상태가 즉시 `IDLE`로 복귀. 디버그 로그에서 3회 연속 재현 확인.
2. **Permission 버튼 라벨 중복**: `truncateLabel()`이 "Yes"와 "Yes, allow all edits during this session" 모두 `'YES'`로 축약 → 버튼에서 구분 불가.
3. **테스트 실패 + 누락**: idle이 option debounce를 취소하는 기존 테스트가 새 동작(idle 무시)과 불일치. Permission의 navigable/cursorIndex 전달 테스트 부재.

### 해결
1. **Interactive cooldown (200ms)**: `output-parser.ts`에 `interactiveCooldown` 타이머 추가. Permission/diff prompt emit 직후 시작, 200ms간 idle 억제. False idle은 같은 PTY batch에서 수 ms 내 도착하므로 실제 idle(사용자 응답 후)에 영향 없음.
2. **`truncateLabel` → `uppercaseShort`**: 모든 "Yes..." → "YES" 축약 제거. 12자 이하만 대문자화, 긴 라벨은 button-renderer의 기존 3-tier 파이프라인(font tier 28→16px + abbreviateLabel + Haiku 폴백) 활용.
3. **테스트 보강**: idle vs option debounce 테스트 수정, permission navigable/cursorIndex 테스트 3개, interactive cooldown 테스트 3개, state-machine permission navigable 테스트 1개 추가 (총 230 pass).

### 교훈
- PTY batch 내 prompt echo(`❯ text`)는 interactive prompt 직후 수 ms 내 도달 — 즉시 발출(no debounce) 프롬프트도 후속 chunk에 대한 cooldown 필요
- Permission 버튼도 option과 동일한 button-renderer 파이프라인을 통하면 라벨 다양성 자연 확보 — 별도 축약 로직은 정보 손실
- `idle` 억제 메커니즘 3종 정리: (1) optionTimer pending → idle 무시, (2) interactiveCooldown → idle 무시, (3) spinner 중 large chunk → idle 무시

---
