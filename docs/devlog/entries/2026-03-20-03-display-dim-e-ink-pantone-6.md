# 2026-03-20 — Display Dim: E-ink 프론트라이트 동적 탐색 + Pantone 6 한계 발견

### 문제
macOS display sleep 시 Android 기기 밝기를 제어하는데, Pantone 6(컬러 e-ink)에서 프론트라이트가 안 꺼짐. 기존 코드가 `/sys/class/backlight/warm/white`만 하드코딩 — Pantone 6의 `aw99703` 경로를 모름.

### 조사 과정
1. **sysfs 동적 탐색**: `KNOWN_BACKLIGHT_DEVICES` 목록으로 probe → `aw99703` 발견했으나 SELinux가 앱 프로세스의 읽기/쓰기 모두 차단
2. **MOAAN Settings 디컴파일** (jadx): `/proc/aw99703/led_brightness` + `led_current` 경로 발견. `FunctionSettingsControl.setLedValue()` → `FileWriter`로 직접 쓰기. 시스템앱(`/system/app/`)이라 SELinux 통과
3. **Settings.Global** (`mogu_warm_led_status` 등): 값은 바뀌지만 하드웨어 미반영 (`mBacklight=null` — framework 연결 없음)
4. **Runtime.exec("cat/echo")**: fork된 프로세스도 앱의 SELinux context 상속 → 동일 차단
5. **KEYCODE_SLEEP/screen_off_timeout**: 화면 OFF는 되지만, wake 시 MOAAN 드라이버가 프론트라이트를 자동 복원 안 함 → 영구 꺼짐

### 결과
- **Crema S**: sysfs `warm/white` app-writable → 정상 동작
- **Pantone 6**: dim 스킵 (프론트라이트 제어 불가, root 필요)
- **Lenovo LCD**: brightness=0 + SCREEN_OFF_TIMEOUT=2s (기존 방식 유지)

### 교훈
- E-ink 프론트라이트 제어는 벤더별 완전히 다름 — sysfs, proc, Settings.Global 어느 것도 표준이 아님
- SELinux가 파일 퍼미션(`rwxrwxrwx`)과 무관하게 앱 context 기반으로 차단
- `Runtime.exec()`은 앱의 SELinux context를 상속 — `adb shell`과 다른 결과
- 화면 sleep 시 프론트라이트가 0으로 리셋되면 앱에서 복원 불가 → screen off 방식은 e-ink에 위험
- MOAAN 전용 API: `/proc/aw99703*/led_{brightness,current}` + `android.os.MoanLedParam` LUT + `Settings.Global` `mogu_*` 키 (하드웨어 무관)

---
