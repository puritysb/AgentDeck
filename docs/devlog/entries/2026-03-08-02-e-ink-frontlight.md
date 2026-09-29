# 2026-03-08 — E-ink frontlight 복구 불가 버그

### 문제
Mac 디스플레이 잠듦 → bridge가 `display_state(off)` 전송 → Android `dimEink()` sysfs `brightness=0` 기록 → bridge 연결 끊김 → `savedFrontlight` 메모리에만 있어 복구 불가. 앱 재시작해도 `isDimmed=false`로 시작하여 restore 호출 안 됨. 백라이트 영구적으로 꺼진 상태.

### 해결
1. **`AgentState.kt`**: Disconnect 시 `hostDisplayOn = true` 리셋 — 상태 불일치 방지
2. **`MonitorService.kt`**: Bridge 미연결 전환 시 이미 dimmed면 즉시 `restore()` 호출
3. **`BrightnessController.kt`**: `SharedPreferences`에 frontlight 값 영속. `init`에서 이전 crash/재시작으로 dimmed 상태가 남아있으면 sysfs 자동 복구. `dimEink()`에서 `current == 0`이면 저장 스킵 (이미 꺼진 값을 restore 대상으로 저장하지 않음)

### 교훈
- **sysfs 직접 제어 시 디스크 영속 필수**: 메모리 전용 상태는 crash/disconnect 시 유실 → 하드웨어가 비정상 상태로 고착
- **Settings.System.SCREEN_BRIGHTNESS는 Crema S frontlight에 무효**: sysfs와 Android Settings API가 별개 경로. frontlight 제어는 sysfs만 동작
- **`bl_power` 주의**: sysfs brightness=0 기록 시 드라이버가 `bl_power=0`(하드웨어 OFF)까지 연쇄 설정할 수 있음. brightness 복원만으로 bl_power가 자동 복구되는지는 디바이스마다 다름

---
