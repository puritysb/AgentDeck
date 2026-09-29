# 2026-03-02 — macOS Display Sleep → Android 백라이트 완전 동기화

### 문제
Cmd+Shift+Power로 Mac 화면을 끄면 Android 디스플레이 백라이트가 제대로 꺼지지 않음:
1. Bridge가 10초마다 `execFile('python3')`으로 `CGDisplayIsAsleep` 체크 — 최대 10초 지연
2. LCD에서 `SCREEN_BRIGHTNESS=0`만 설정 — 최소 밝기일 뿐 백라이트 미해제, auto-brightness 모드에서는 무시됨
3. E-ink `SCREEN_OFF_TIMEOUT` 15초 — 너무 느림

### 해결
1. **Persistent python3 process**: `execFile` → `spawn` + `readline`. Python 스크립트가 2초마다 루프하며 상태 변경 시에만 stdout 출력. 비정상 종료 시 5초 후 재시작 (최대 3회)
2. **LCD 3단계 dim**: `SCREEN_BRIGHTNESS_MODE` 강제 manual → brightness 0 → `SCREEN_OFF_TIMEOUT` 2s (백라이트 완전 해제). Restore 순서: timeout 복원 → WAKEUP → brightness → mode
3. **E-ink timeout**: 15s → 3s

### 교훈
- `SCREEN_BRIGHTNESS=0`은 "최소 밝기"이지 "백라이트 off"가 아님. 실제 꺼짐은 `SCREEN_OFF_TIMEOUT` 만료 후 시스템이 처리
- Auto-brightness 모드에서는 `SCREEN_BRIGHTNESS` 설정이 무시될 수 있으므로 반드시 manual 모드로 전환 필요
- 매번 프로세스 spawn하는 폴링은 persistent process + readline으로 대체하면 지연과 오버헤드 모두 개선

---
