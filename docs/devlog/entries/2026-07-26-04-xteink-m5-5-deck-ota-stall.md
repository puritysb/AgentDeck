# 2026-07-26 — XTeink M5.5 Deck 영속화 + OTA 수신 stall 타임아웃

`crosspoint-agentdeck` 포크 커밋 d98d7abd(M5.5) + 6c4506b1(stall fix). 배포는 전부 `agentdeck esp32-ota xteink_{x3,x4} --firmware` WiFi OTA.

### M5.5 — Deck 영속화 (decision-card 로드맵 3번 완료)

E-ink 는 "항상 무언가를 보여주는 표면"이라는 Face 원칙의 나머지 반쪽: 연결되기 **전**에도 내용이 있어야 한다. 살아있는 세션들의 표시 필드(sid/project/agentType/state/activity/awaiting)를 `/.crosspoint/agentdeck-deck.bin` 에 영속화(`src/agentdeck/deck_store.*`, 헤더 magic+`sizeof(Record)`=스키마 버전, tmp+rename 이라 플래시 중 전원이 나가도 직전 deck 유지). 부팅 시 onEnter 가 첫 페인트 **전에** 로드해서 Wi-Fi join·발견·연결이 진행되는 동안 마지막 deck 를 렌더.

정직성 규칙이 설계의 대부분이다:
- **`Last synced deck · as of Xh ago`** 볼드 라인 — 시계 소스가 생기는 순간(NTP 착지, 또는 저장 시점의 데몬시계 추정) age 가 나타나고, 그 전엔 숫자를 날조하지 않는다. SNTP 착지 시 1회 리페인트.
- 캐시 행은 **표시 전용**: attention 배너·키보드 포커스·Open 힌트 억제(오프라인에서 누를 수 없는 행동 유도 금지 — 행동은 M6 Outbox 의 몫). `controlMode` 도 비워서 어떤 경로로도 명령이 못 나가게.
- **live 가 항상 이긴다**: `dataReceived` 초크포인트 — 연결 후 첫 상태가 도착하면 "세션 0개"라는 사실조차 캐시보다 우선.
- 저장은 Connected 에서 deck 내용 시그니처가 바뀔 때만(5s 스로틀, FNV 선계산 후 3.5KB 스냅샷은 힙 스크래치 → SD → g_stateMutex 아래 swap; C3 스택에 올리지 않는다).

### OTA 수신 stall 타임아웃 (오늘 실전에서 얻어맞고 바로 고침)

X3 전송 중 데몬이 죽자(chunk #2898/5233) 수신기가 `rx.active` 를 영원히 물고 있었다 — activity 는 "전송 중 이탈 금지"로 **모든 입력을 삼키므로 재부팅 전까지 soft brick**. `OtaWs::service()`(매 루프 틱)가 begin/chunk 무트래픽 30s 에 abort + SD 캐시 정리(데몬 자체 chunk ack 타임아웃이 ~10s 라 30s 침묵=송신자 사망 확정). 재시도는 어차피 `esp32_ota_begin` 에서 클린 리스타트.

### 실기 배포 관찰 (버그 아님, 운영 지식)

- **플래시 실패와 성공은 원격에서 정반대 신호**: 실패=재부팅 없음 → 기기가 **구 buildHash 로 계속 접속 유지**. 성공=ESP.restart → **일시 오프라인**. "OTA complete"(전송+검증 ack)는 플래시 성공을 의미하지 않는다 — 판정은 반드시 재접속 후 buildHash.
- X4: d98d7abd 플래시+재부팅+재접속까지 원격 실증(M5.5 라이브). X3: 오늘 두 번 모두 플래시 실패(88aaf098 잔류).
- 병렬 세션이 같은 데몬을 재시작하며 작업 중이었다(t_embed) — 세션에서 스폰한 데몬은 언제든 외부에서 SIGTERM 될 수 있고, 그게 OTA 전송 중이면 위 stall 케이스가 된다. `esp32-flash-daemon-respawn-contention` 의 WiFi OTA 판.

### 플래시 실패 원인 확정 — `err=OOM` (포크 6ccbe140 에서 수정)

사용자가 X3 를 File Transfer 모드로 올려줘 SD `/agentdeck.log` 를 원격 회수(`GET /download?path=/agentdeck.log`). 오늘 X3 의 두 실패 모두 `error stage=flash err=OOM` — **4 KiB 스테이징 버퍼의 힙 할당**이 전송 완료 28ms 뒤에 실패한 것. 최초 OTA(부팅 6.9분, young heap)는 성공했고 오늘 시도(가동 88/108분)는 실패 — SD 폰트 글리프 캐시+WS churn 으로 단편화된 no-PSRAM C3 힙에는 4 KiB 연속 블록조차 없다. 게다가 **플래시 실패는 재부팅을 안 하므로 단편화가 그대로 남아 재시도도 계속 실패**하는 자기강화 구조(X4 지난 1차 실패→재부팅 후 재시도 성공과 정합). 수정: `FirmwareFlasher` 의 validate/flash 가 **정적 4 KiB 버퍼 공유**(둘 다 메인 태스크 전용) — 플래시 경로에서 런타임 할당 전면 제거. OOM-fix 펌웨어는 File Transfer 웹 업로드로 X3 SD 에 적재(`crosspoint-6ccbe140.bin`, 바이트 일치 검증) — 구펌 SD-update 경로도 같은 힙 할당을 쓰므로 **재부팅 직후(young heap) 실행**이 안전한 적용 경로.

X4 로그(동일 경로로 회수)가 그림을 완성: 총 5회 시도 중 **OOM 3회**(80분 uptime 1회 — 지난 세션의 미확정 1차 실패, 88분/108분 X3 2회, 그리고 **부팅 7분 시점 1회** — 전송 자체의 5,233회 base64+JSON churn 만으로도 터진다), 성공 2회(2.6분 young heap + 61분 1회 = 확률적). 즉 "재부팅 직후 푸시" 운영 지침만으로는 불충분하고 정적 버퍼가 유일한 완결 수정. 부수 발견 2건: ① 데몬이 전송 중 죽으면 구펌(stall fix 이전)은 `esp32_ota_begin` 만 기록하고 영원히 대기(6c4506b1 이 고친 그 케이스의 실기 로그), ② X4 의 반복 실패는 **RSSI -86** 위치 문제가 겹쳐 있었다(공유기 옆 -60 에서 웹 업로드 즉시 성공; 크래시된 업로드 후엔 웹서버 GET 인자 파싱이 빈 값으로 망가져 재부팅 필요).

---
