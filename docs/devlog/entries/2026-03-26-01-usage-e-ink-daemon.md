# 2026-03-26 — Usage 리셋 버그 + E-ink 시간 표시 잘림 + Daemon 좀비 프로세스

### 문제
1. **Usage % 미리셋**: 5h/7d 윈도우 만료 시 시간은 "now"로 표시되나 사용량 %는 이전 값 유지
2. **E-ink 리셋 시간 잘림**: `EinkStatusCompact`의 gauge+percent+reset을 한 줄(`maxLines=1`)에 넣어 "4h 12m"이 "4h"로 잘림. 태블릿/Apple은 별도 줄이라 문제 없음
3. **Pantone 6 rotation 실패**: APK 재설치 시 `WRITE_SETTINGS` 권한 초기화 → RK3566의 system rotation fallback 무효
4. **Daemon 좀비**: `httpServer.close(callback)` — CLOSE_WAIT 연결이 드레인 안 되면 callback의 `process.exit(0)` 미실행, 프로세스가 LISTEN 소켓 없이 좀비화

### 해결
1. `adjustUsagePercent(percent, resetsAt)` — `resetsAt <= now`이면 0% 반환. Bridge broadcast 계층(`usage-event.ts`)에 적용하여 모든 WS 클라이언트 일괄 수정. Plugin standalone fetch 경로도 동일 적용. Apple `formatResetTime` nil→"now" 수정
2. E-ink `GaugeText`에서 리셋 시간을 `⟲ 4h 12m` 별도 줄로 분리 — 태블릿 `WaterGauge` 포맷과 통일
3. `onCreate` 즉시 `requestedOrientation = LANDSCAPE` + `applySystemRotation()` 호출 (DataStore 비동기 대기 제거). `!canWrite()` 시 `ACTION_MANAGE_WRITE_SETTINGS` 자동 열기
4. `setTimeout(() => process.exit(0), 5000).unref()` — Session bridge에는 이미 3초 failsafe 있었으나 daemon에만 누락

### 교훈 / 핵심 설계 결정
- **Bridge broadcast 계층이 최적의 수정 지점**: 모든 클라이언트(TUI/Android/Apple/ESP32)가 WS로 데이터 수신 → bridge에서 한 번 보정하면 전체 적용
- **E-ink 30% 컬럼에 monospace 한 줄은 22자 초과 시 잘림**: 향후 E-ink 텍스트는 가로 여유 확인 필수
- **`httpServer.close()` 콜백은 보장되지 않음**: CLOSE_WAIT 연결이 있으면 무한 대기. 항상 shutdown timeout 패턴 적용
- **특수 권한(`WRITE_SETTINGS`)은 APK 재설치 시 초기화**: manifest 선언만으로 부족, 앱에서 자동 요청 로직 필수

---
