# 2026-03-30 — TC001 2-Page Dashboard + Multi-Device Rendering Improvements

### 문제
TC001 3페이지 중 INFO(세션명·모델 스크롤)가 불필요. 게이지 색상이 Pixoo 대비 가시성 낮음. E-ink OpenCode 캐릭터가 세로로 너무 긴 직사각형. 시뮬레이터와 실제 기기 간 괴리.

### 해결
1. **TC001**: INFO 페이지 제거 → USAGE + AGENTS 2페이지만 8초 순환. 게이지 색상 Pixoo 매칭(Blue→Teal→Amber→Red+pulse). 에이전트 애니메이션 blink→smooth sine pulse. 미연결 시 "SEARCHING..." 스크롤 텍스트
2. **E-ink OpenCode**: `EINK_OPENCODE_PIXEL_ASPECT = 1.2f` 전용 상수 (기존 2.0f). Octopus는 2.0 유지
3. **시뮬레이터**: TC001 INFO 패널 제거, SD 세션 버튼 실제 플러그인 매칭, Pixoo usage HUD 추가

### 핵심 설계 결정
- **TC001 flash_size 8MB 필수**: PIO `esp32dev` 보드 기본값 4MB로 플래시하면 부트로더 오동작 → GPIO15(부저) HIGH 고정 + 화면 미출력. `board_upload.flash_size = 8MB` 추가 + esptool 직접 사용 시 `--flash-size 8MB` 명시. 이 문제로 수 차례 팩토리 복원 반복
- **CH340 포트 식별**: TC001과 86 Box 모두 CH340이고 포트 번호가 재연결마다 변동. device_info_request 없이 포트만 보고 플래시하면 잘못된 보드에 펌웨어 올릴 위험
- **TC001 시리얼 출력 불가**: 팩토리 펌웨어도 시리얼 없음. 디버깅은 LED 출력으로만 가능
- **3x5 폰트 N=M**: 글리프 동일 → "OFFLINE"/"NO HOST" 대신 "SEARCHING..." 사용

---
