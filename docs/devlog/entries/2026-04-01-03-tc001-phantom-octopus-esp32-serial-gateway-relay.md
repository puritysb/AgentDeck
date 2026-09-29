# 2026-04-01 — TC001 Phantom Octopus + ESP32 Serial Gateway Relay Bug

### 문제
1. TC001에 OpenClaw만 실행 중인데 유령 문어 표시
2. 모든 ESP32 기기에서 가재(OpenClaw) 미표시 — Pixoo/D200H와 불일치

### 해결
1. `matrix_pages.cpp` renderAgents(): `octoCount==0 && gatewayAvail` 시 fallback 문어 스킵. 미연결 시 가재도 숨김 (`connected && gatewayAvail` 체크)
2. `ESP32Serial.swift` prepareForSerial(): `gatewayAvailable`/`gatewayHasError`를 state_update에서 삭제하고 있었음 → 유지하도록 수정. `sessions_list`에서 `alive`/`id` 필드 누락도 수정

### 핵심 설계 결정
- **시리얼 페이로드 최적화 시 기능 필수 필드 삭제 주의**: ESP32Serial이 시리얼 크기 최적화를 위해 필드를 삭제할 때, 렌더링에 필수인 `gatewayAvailable`까지 삭제. 최적화 대상 필드를 화이트리스트가 아닌 블랙리스트로 관리해야 이런 사고 방지
- **TC001 USAGE 페이지 Pixoo HUD 통일**: "5H"/"7D" 라벨 → 퍼센트 숫자(게이지색) + 리셋 시간(뮤트 그레이). 글리프도 Pixoo `PIXEL_FONT` (filled/blocky) 스타일로 교체 — LED 매트릭스에서 가독성 향상

---
