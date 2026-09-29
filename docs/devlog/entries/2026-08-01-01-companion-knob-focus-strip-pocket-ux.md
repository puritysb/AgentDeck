# 2026-08-01 — Companion Knob·Focus Strip·Pocket UX 리뷰 라운드 + 실기 배포

세 신규 보드 펌웨어(T-Embed Knob / S3-Pro Ticker / S3-Pro Pocket)를 디자인·UX
관점에서 재검토하고 격차를 수정, 실기 2대에 배포했다.

### 문제
- **Pocket에 permission gate 응답 수단이 없었다** — Ticker는 APPROVE/DENY 칩이
  있는데 휴대형 Pocket은 amber rail+INPUT 표시뿐. 세션 목록도 roster 순서라
  awaiting 카드가 스크롤 아래로 묻힐 수 있었고, 휴대 유닛인데 배터리 표시도 없었다.
- **Knob hold-to-talk(400ms 시작)와 SHORT_PRESS(<600ms 릴리즈) 충돌** —
  0.4~0.6s 잡고 말하면 음성 전송과 detail 메뉴 열림이 동시에 발생.
- **serial-primary 파킹 중 세 UI 모두 빨간 WiFi 아이콘** — 건강한 USB 도킹이
  장애처럼 보였다. 고정높이 WRAP 라벨은 마지막 줄을 글리프 중간에서 절단.
- voice_result 한글 전사문이 flash 버퍼(48B)에서 UTF-8 중간 절단 + 1.2s 만에 사라짐.

### 해결
- Pocket awaiting 카드 확장(질문 + DENY/APPROVE 칩; requestId는 **탭 시점 라이브
  재조회** — stale이면 "already answered"로 강등, 오발사 불가). Ticker와 동일한
  glance 우선순위 정렬(awaiting→focus→processing→roster), 상태바 배터리(전압만 —
  SY6970은 SOC 레지스터가 없어 퍼센트를 지어내지 않는다), 구독 라인, `·` tofu 수정.
- 캡처 중 엔코더 키 이벤트를 마이크가 소유(릴리즈=캡처 종료만). 캐러셀에 디텐트
  방향 슬라이드-인(140ms ease-out — 상태색 애니 금지 규칙과 무관한 인터랙션 피드백).
  flash 96B+utf8TrimEnd+2.2s. 세 UI 모두 serial 연결 시 초록 USB 글리프,
  잘리는 라벨은 LONG_DOT(말줄임표)로.
- Ticker 세션 페이지 3행 초과분 "+N more" 표시, ticker/pocket agentColor에
  antigravity 추가(Knob에만 있던 4표면 불일치 해소).

### 배포와 교훈
- t_embed + S3-Pro(USB 유닛) USB 플래시, `e0cdb7a7-dirty` 부팅 확인. 도중
  **데몬 재스폰 경합 재현**(다른 세션이 데몬 재기동→포트 점유→esptool "chip
  stopped responding"; lsof로 판별 후 재정지). 두 번째 S3-Pro(.81)는 오프라인
  전환으로 미배포(빌드 산출물 유지, IP 타깃 OTA 한 줄로 가능).
- knob_ui.cpp/main.cpp 델타는 병렬 세션 커밋 b6d8fdaa에 휩쓸려 선반영됨 —
  같은 트리 다중 세션의 수렴 패턴 그대로.
- 같은 board 2대 운용의 실제 함정: `wifiEsp32Key`는 `board:ip`(유닛 분리 맞음
  — 초기 "키 충돌" 진단은 오진으로 정정)이지만 `serialActive`는 board 단위
  계산이라 WiFi 전용 유닛 항목이 오염되고, **stale=False≠소켓 OPEN**(registry는
  lastSeen 기준, 소켓은 close 즉시 삭제)이라 OTA가 신선해 보이는 항목에도
  실패한다. 메모리 `esp32-same-board-two-units-ota-key-collision`.
- Ticker의 CAM 페이지(~150줄)는 현재 도달 불가 코드 — 카메라가 probe되면 부팅이
  무조건 Pocket을 선택한다. 정리 후보로 기록만.

---
