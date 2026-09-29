# 2026-05-05 — Android tablet OpenClaw foreground 배치 보정

### 문제

Android tablet Monitor 화면에서 OpenClaw 메인 가재가 하단 `TIMELINE` detail pane 과 겹칠 때,
Compose 레이어 순서상 terrarium canvas 전체가 먼저 그리고 `TimelineStrip` 이 나중에 올라와 가재가
텍스트 뒤에 가려졌다. 기존 canvas 내부 draw order 를 조정해도 Compose sibling 인 TIMELINE 보다
앞으로 나올 수 없는 구조였다.

### 해결

- Tablet Monitor 전용 OpenClaw 기준점을 기존 우하단 모래선 근처에서 위/왼쪽
  (`x=0.70`, `y=0.575`) 으로 옮겨 TIMELINE detail pane 침범을 줄이면서 오른쪽 HUD rail 을 피했다.
- 활성 OpenClaw 상태에서는 메인 가재를 배경 canvas 에서 빼고 `TimelineStrip` 뒤가 아닌 별도
  foreground canvas 에서 그리도록 분리했다. 레이어 순서는 `TIMELINE < OpenClaw < HUD/gear` 로
  유지해 OpenClaw 는 TIMELINE text 보다 앞에 나오되, topology rail 같은 HUD 텍스트는 가리지 않는다.
- Worker 가재 배치는 조정된 메인 가재 기준점을 받을 수 있게 하여 tablet 위치 변화와 같이 움직인다.

### 검증

- `./gradlew :app:compileDebugKotlin` 성공.
- `bash scripts/build-android-release.sh` 성공 → `dist/agentdeck-v0.4.1.apk`.
- ADB 설치 완료: Lenovo TB-J606F (`HVA095B4`, `lastUpdateTime=2026-05-05 13:34:25`),
  Pantone6 (`AA007422R24C1300039`, `lastUpdateTime=2026-05-05 13:36:44`).
- Lenovo TB-J606F 실기기 screenshot 으로 레이어 순서 확인.

---
