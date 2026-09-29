# 2026-02-22 — Ghost Option from Stale Buffer Content

### 문제
Claude 응답에 번호 목록(예: 계획 단계 "3. ... 5. Deploy")이 포함된 후 4개 옵션 프롬프트가 바로 이어지면, `parseOptions(this.buffer.slice(-1000))`가 이전 응답의 "5."와 현재 옵션 1-4를 모두 파싱. contiguous 필터가 0-4를 유효로 판단하여 Stream Deck에 유령 5번째 옵션 표시.

### 해결
1. **Backward scan**: `parseOptions()`에서 정규화 후 역방향 스캔으로 마지막 연속 옵션 블록만 추출. 끝에서부터 footer 건너뛰고, 옵션 라인을 수집하되 비옵션·비공백 라인(질문 텍스트 등)에서 정지. 이전 응답의 번호 항목은 블록 경계 밖이라 자연 배제.
2. **Idle prompt guard (기존 버그 수정)**: cursor-only redraw 감지 조건에 `!hasIdlePrompt` 추가. 이전에는 `lastNavigableEmit=true` 상태에서 `❯ \n`(공백 포함 idle 프롬프트)도 커서 redraw로 오인하여 idle 전환 불가.

### 교훈
- PTY 버퍼 기반 파싱에서 "최근 N바이트"만 보는 방식은 이전 출력의 패턴 오염에 취약 — 구조적 경계(블록 분리)가 필수
- cursor-only redraw 감지는 `❯` 문자만으로 판단하면 idle prompt와 충돌 — idle prompt는 `❯` 뒤 공백 필수라는 차이점으로 구별

---
