# 2026-04-01 — Plugin v4 Cleanup + Session-Slot UI Overhaul

### 문제
1. v3 keypad actions (5개) 가 manifest에 남아 SD 앱 action list에 불필요 항목 노출
2. Session-slot 버튼의 agent watermark 거의 안 보임 (opacity 0.06)
3. OpenClaw 세션이 Claude Code와 동일한 상태 라벨/색상 사용
4. ESC/STOP 버튼이 IDLE 시 완전히 사라짐
5. No-daemon 시 "Empty" 표시 버그 (willAppear에서 daemonConnected 미체크)
6. 플러그인 아이콘이 컬러 앱 아이콘 — SD 컨벤션(투명+흰색 모노크롬)과 불일치

### 해결
1. v3 actions 5개 + expanded-actions + LayoutManager 클래스 + 14 PNGs + PI html 삭제 (manifest 10→5 actions)
2. `dimColor()` 방식 — 색상 50% 어둡게 + opacity 3배 → 선명하면서 텍스트 비침
3. OpenClaw: IDLE→STANDBY(cyan), PROCESSING→ROUTING(green), 중복 라벨 제거
4. ESC/STOP slot 4에 항상 표시 (active=bright, idle=dimmed)
5. willAppear에서 `daemonConnected` 체크 추가, slot 0에 ▶ START 버튼
6. rsvg-convert로 투명배경+흰색 terrarium SVG 아이콘 생성

### 핵심 설계 결정
- **Detail view 2×4 grid**: 0=BACK, 4=ESC/STOP (아래), 1=INFO, 2/3/5/6=content, 7=pagination
- **OpenClaw presets**: STATUS(send_prompt), MODEL(dynamic icon+switch animation), GATEWAY(browser)
- **Model switch feedback**: `startModelSwitch()` → loading icon → `checkModelSwitchDone()` (modelName 변경 감지 or 12s timeout)
- **SD MCP 평가**: `@elgato/mcp-server`는 "AI가 미리 배치된 버튼 트리거"만 가능. 우리 동적 SVG/인코더 LCD 대비 이점 없음 → 통합 불요

---
