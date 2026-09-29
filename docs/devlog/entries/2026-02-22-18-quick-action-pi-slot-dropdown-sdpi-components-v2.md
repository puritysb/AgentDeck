# 2026-02-22 — Quick Action PI: Slot Dropdown 제거 & sdpi-components v2 API

### 문제
1. **PI ↔ 버튼 불일치**: PI의 Custom Label/Action 필드가 빈 값으로 표시되지만, 실제 버튼은 정상 동작. `onWillAppear`에서 `slotIndex`만 persist하고 `label`/`action`은 persist하지 않아, PI(sdpi-components 자동 바인딩)는 빈 설정을 보지만 버튼 렌더링은 코드 내 `effectiveSettings()` → `DEFAULT_IDLE_SETTINGS` 폴백으로 정상 표시.
2. **`$SD is not defined`**: sdpi-components v2에 `$SD` 전역 변수가 없음. `$SD.on('didReceiveSettings', ...)` 호출 시 ReferenceError.
3. **5번째+ 버튼 빈 표시**: `autoAssignSlot()`이 `actionSlots.size`(4+) 반환 → `DEFAULT_IDLE_SETTINGS[4]`가 undefined → 빈 버튼.

### 해결
1. **Defaults persist**: `onWillAppear`에서 `settings.label == null || settings.action == null`이면 슬롯 defaults를 실제 settings에 `setSettings()` — PI가 값을 직접 표시.
2. **sdpi-components v2 API**: `window.SDPIComponents.streamDeckClient.didReceiveSettings.subscribe(fn)` 사용. 콜백 파라미터는 `actionInfo` 전체 객체 (`jsn.payload.settings`로 접근).
3. **autoAssignSlot cap**: `return DEFAULT_IDLE_SETTINGS.length - 1` (마지막 슬롯 CLEAR로 캡).
4. **슬롯 드롭다운 제거**: PI에서 `<sdpi-select setting="slotIndex">` 제거, 읽기 전용 "Slot N" 표시로 대체.

### 교훈
- **sdpi-components v2 이벤트**: `$SD`는 v1 API. v2는 `SDPIComponents.streamDeckClient`가 클라이언트이며, `didReceiveSettings`/`didReceiveGlobalSettings`/`sendToPropertyInspector`/`message`는 `{ subscribe(), unsubscribe(), dispatch() }` 패턴의 이벤트 에미터. 초기 connect와 WS 메시지 모두 동일 에미터로 dispatch.
- **PI 필드 값 vs placeholder**: sdpi-components는 `setting` 속성으로 자동 바인딩 — persist된 값이 있으면 필드에 표시, 없으면 빈 칸(placeholder만 보임). 버튼 로직이 코드 내 defaults를 merge하더라도, PI는 persist된 settings만 봄. 불일치 방지를 위해 defaults를 settings에 실제 persist 필요.
- **autoAssignSlot 범위 초과**: slot >= N이면 `DEFAULT_IDLE_SETTINGS[slot]`이 undefined — 안전한 캡 필수.

---
