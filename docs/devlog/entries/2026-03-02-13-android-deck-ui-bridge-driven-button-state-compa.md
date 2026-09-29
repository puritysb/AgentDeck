# 2026-03-02 — Android Deck UI 개선: bridge-driven button_state + compact layout

### 문제
1. Android Deck 탭 버튼이 `aspectRatio(1f)` 정사각형으로 10" 태블릿에서 ~260dp 차지, Context Area 부족
2. 버튼 내용이 Android 로컬 하드코딩 — SD+ 플러그인 PI 커스텀 설정과 불일치
3. AWAITING 상태에서 MORE 눌러야 전체 옵션 표시, PROCESSING시 진행 표시 부족

### 해결
- **`button_state` 프로토콜 신설**: Bridge `computeButtonState()` → 8개 슬롯 상태 계산 + WS broadcast. `ButtonSlotState` 타입 (shared/protocol.ts), Android `parseBridgeMessage()` 파싱, `DashboardState.buttonStates` 필드 추가
- **Bridge-driven 우선, 로컬 fallback**: `computeDeckLayout()`이 `buttonStates.isNotEmpty()` 체크 → bridge 데이터 사용, 미연결시 기존 로컬 로직 유지
- **PI 설정 반영**: `cachedSlotMap`에서 `response-button` 슬롯의 PI settings(label/action) 추출하여 IDLE 버튼에 적용
- **CompactStatusBar(36dp)**: 프로젝트명 + 상태칩(colored dot) + 모델명 + usage% pill 배지
- **직사각형 버튼(80dp)**: `aspectRatio(1f)` 제거 → ~84dp 추가 Context Area 확보
- **터치 피드백**: scale(0.95) + alpha(0.85) 애니메이션, icon/badge 렌더링
- **Context Area 개선**: AWAITING시 전체 옵션 LazyColumn 항상 표시 (cursor highlight + shortcut badge), PROCESSING시 LinearProgressIndicator + ProcessingDots, IDLE시 suggestedPrompt AssistChip
- **Action dispatch 이중 경로**: bridge-driven `actionString` 직접 실행 + 로컬 `DeckAction` sealed class fallback

### 핵심 설계 결정
- `computeButtonState()`는 `computeEncoderState()`와 동일 패턴 — state_changed/connect/slot_map 3곳 broadcast
- `colorForOption` 로직이 plugin/bridge/android 3곳에 중복 — 향후 shared util 추출 고려
- DIM 버튼은 `{ ...DIM, slot: N }` spread override 패턴 사용

---
