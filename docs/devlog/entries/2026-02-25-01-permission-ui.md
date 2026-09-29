# 2026-02-25 — Permission 스크롤 시 UI 소멸 + 옵션 라벨 오염 수정

### 문제
`sdc -d` 디버그 세션에서 2가지 반복 버그 발견 (4회 재현):
1. **PERMISSION 스크롤 시 UI 소멸**: 3개 옵션 표시 상태에서 다이얼 스크롤(navigate_option)하면 permission 메뉴가 갑자기 사라짐 (`awaiting_permission → idle` 오전이)
2. **옵션 라벨 오염**: Bash permission의 "don't ask again for: file:*" 가 "file "/Users/..."/* 2>/dev/null" 로 표시

### 해결
**Bug 1**: `output-parser.ts` cursor-only redraw 분기의 `!hasIdlePrompt` 조건이 원인. `IDLE_PROMPT` (`/^[❯>][ \t\u00A0]/m`)이 스크롤 chunk의 `❯ Yes, allow...` 옵션 텍스트를 idle prompt로 오감지 → idle handler로 fall through. **수정**: `!hasIdlePrompt` 제거, 대신 chunk 크기 기반 판별 (`nonWs < 10` = genuine idle, 그 외 = scroll redraw). 진짜 idle(`❯ \n`)은 작은 chunk, 스크롤은 큰 chunk라는 특성 활용.

**Bug 2**: Claude Code ink TUI의 2-pass 렌더링이 원인. 첫 draw에서 full command 텍스트가 option 행에 렌더링되고, 16ms 후 CUP로 커서 되돌려 `:*`로 덮어씀. 터미널에선 정상이지만 linear buffer는 양쪽 모두 append → 오염. **수정**: `parseOptions()` 내 byIndex 완성 후, correction line 패턴 (`/^(:\S+)\s{5,}/`) 감지 → "don't ask again" 라벨의 오염된 command+args를 `command + correctionScope`로 교정.

### 교훈 / 핵심 설계 결정
- **IDLE_PROMPT 오매칭**: `❯ ` 패턴은 idle 전용이 아님 — navigable cursor 옵션 텍스트도 `❯ label`로 시작. Chunk 크기가 더 신뢰할 수 있는 판별자
- **TUI CUP 덮어쓰기**: ink 프레임워크는 성능상 incremental redraw를 사용하여 CUP로 부분 수정. Linear buffer에서는 이를 감지·보정해야 함
- **Linear buffer 한계**: CUP/HVP를 `\n`으로 치환하는 현재 방식의 근본적 한계. 향후 복잡한 TUI 렌더링 케이스가 더 발생할 수 있음

---
