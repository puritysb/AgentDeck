# 2026-04-03 — Usage Dial Text Overlap Fix + D200H Usage Monitor

### 문제
(1) SD+ Usage Dial (E3) overview 페이지에서 사용량 %와 리셋 시간 텍스트가 겹침 — 같은 Y좌표에 배치 (2) Detail 페이지에서 20px 한 줄에 "100% · 23h 59m" 합쳐서 200px 초과 (3) Extra Usage 페이지에 크레딧 정보 미표시 (4) D200H에 사용량 모니터링 없음

### 해결
**Plugin Usage Dial**: overview에서 % text-anchor="end" 우측 정렬 + 리셋 시간 별도 줄 분리 (y+11). Detail에서 % 단독 라인 + "resets in Xh" 별도 줄. Extra Usage에 $used/$limit 표시. 리셋 시간 폰트 11px→13px, 색상 밝게.

**D200H**: 세션 리스트 모드에서 slot 12(우측 하단)를 usage monitor로 할당. 12 sessions/page + 1 usage. "5H XX% Xh\n7D YY% Xh" 텍스트 + color-coded solid border (green/yellow/red).

### 핵심 설계 결정
- **D200H에서 커스텀 PNG 렌더링 금지**: Core Graphics로 게이지 바를 직접 그린 PNG는 ZIP 크기/바이트 경계 변화로 D200H 펌웨어가 거부 (울란지 기본 시계 복귀). 표준 renderButtonPng만 사용하고 시각 정보는 디바이스 네이티브 텍스트 + border color로 전달
- **Extra Usage 데이터 파이프라인**: protocol의 extraUsageMonthlyLimit/extraUsageUsedCredits를 UsageModeData로 전달, 렌더러에서 "$X.XX / $Y.YY" 표시

---
