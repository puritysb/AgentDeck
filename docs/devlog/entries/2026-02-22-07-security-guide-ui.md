# 2026-02-22 — Security Guide 커서선택 UI 오분류 수정

### 문제

`sdc`로 새 프로젝트 진입 시 Security Guide("Yes, I trust this folder" / "No, exit")가 `permission_prompt`로 분류되어 `y\r`을 전송. 하지만 이 프롬프트는 커서 선택 UI(`Enter to confirm`)이므로 Enter 키만 필요.

### 해결

`isCursorSelectionUI()` 메서드 추가 — buffer에서 `Enter to confirm` 패턴 감지 시 `option_prompt`(navigable)로 분류하여 arrow key + Enter로 선택.

### 교훈

**ANSI 커서 제어로 공백이 제거되는 현상**: PTY 출력을 `stripAnsi()` 처리하면 ANSI cursor positioning(`\x1b[nC` 등)이 제거되면서 단어 사이 공백도 사라짐. 예: `"Enter to confirm"` → `"Entertoconfirm"`. output-parser에서 텍스트 패턴 매칭 시 **`\s+` 대신 `\s*`를 사용**해야 안전함. 이는 Claude Code TUI가 cursor positioning으로 텍스트를 배치하기 때문에 발생하는 구조적 특성.

---
