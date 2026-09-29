# 2026-02-22 — Option Dial: Navigable 모드 경계 스크롤 시 인덱스 desync 수정

### 문제
옵션 리스트(navigable 모드)에서 끝까지 스크롤한 뒤 방향을 반전하면 디스플레이 인덱스와 PTY 커서가 어긋남. 원인: `selectedIndex`가 `Math.min/max`로 clamp되어 변하지 않는데도 `navigate_option` 메시지를 브릿지에 무조건 전송 → PTY 커서만 계속 이동.

### 해결
`onDialRotate`와 `handleTakeoverRotate` 양쪽에서 `prevIndex`를 저장하고, `selectedIndex !== prevIndex`일 때만 `navigate_option`을 전송하도록 guard 추가.

### 교훈
- Clamp 로직과 side-effect(메시지 전송)를 분리할 때, "값이 실제로 변했는가"를 반드시 검증해야 함

---
