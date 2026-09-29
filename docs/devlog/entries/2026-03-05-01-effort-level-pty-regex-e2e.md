# 2026-03-05 — Effort Level PTY regex E2E 검증 및 보정

### 문제
이전 세션에서 effortLevel 파이프라인 전체 구현 완료했으나, regex가 **추측 패턴**(`Effort: high`)으로 작성됨. 실제 Claude Code PTY 출력 미확인 상태.

### 해결
node-pty로 Claude Code를 스폰하여 `/model` → effort level 변경 시 실제 PTY 출력 캡처.

**실제 패턴 (예상과 완전히 다름):**
- 선택 중: `▌ High effort <- -> to adjust` (level이 "effort" **앞에** 위치)
- 확인 후: `with high effort` / `Opus 4.6 with high effort . Claude Max`
- 레벨: `high`, `medium`(default), `low` ("auto"는 존재하지 않음)

**수정:** `/\beffort\s*[:·]\s*(high|low|auto)\b/i` -> `/\b(high|medium|low)\s+effort\b/i`

### 교훈 / 핵심 설계 결정
- **PTY 패턴은 반드시 E2E 검증 필요** — Claude Code TUI는 ANSI 시퀀스 + block characters(`▌`) + 독자적 레이아웃 사용. 추측으로 regex 작성하면 100% 미매칭
- **"medium"은 기본값이므로 UI에서 숨김** — high/low만 모델명 옆에 표시 (Session 버튼, Android 세션 목록, E-ink 에이전트 블록 모두 동일 로직)
- **E2E 테스트 방법**: `node-pty`로 Claude CLI 스폰 → trust dialog 자동 수락 → `/model` 입력(2초 후 Enter 분리 전송) → arrow key로 effort 순환 → 출력 캡처. Command palette autocomplete 때문에 `/model\r` 동시 전송 시 실행 안 됨

---
