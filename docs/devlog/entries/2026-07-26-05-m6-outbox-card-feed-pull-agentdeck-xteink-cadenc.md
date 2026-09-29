# 2026-07-26 — M6 Outbox + 전원 사다리: card-feed pull 계약(AgentDeck) + XTeink 딥슬립 cadence(포크)

AgentDeck 89f538c5 + `crosspoint-agentdeck` 포크 da66432a. client-contract 원칙대로 **계약을 `shared/src/protocol.ts`에 먼저** 정의하고 포크에 re-port.

### AgentDeck 쪽 — Card Feed Pull Sync 계약 + Node 데몬 엔드포인트

- **`actionClass` (live/day/info)**: 카드별 오프라인 유효성 계급. `live`(권한 게이트·awaiting 프롬프트)=캐시본 회색화+TTL 만료, `day`=하루 유효·Outbox 큐잉(M7 카드 모듈 전까지 생산자 없음, 스키마만 예약), `info`=읽기전용+sync age. M6 카드는 전부 세션 파생(`cardId: "session:<sid>"`, body=`sessions_list`와 동일한 SessionInfo).
- **`GET /feed`** → `card_feed`: serverTime/serverHm(드리프트 RTC 재앵커) + `nextPullSec`(전원 사다리의 데몬 절반: idle 3600 / 세션 활성 900) + actionClass 스탬프 카드. `BridgeCore.buildSessionsSnapshot()`로 sessions_list 파이프라인을 그대로 추출해 WS 클라이언트와 동일한 뷰 보장.
- **`POST /outbox`**: 결정별 결과를 요청 순서대로 반환, **라이브 상태 기준 검증** — permission_decision은 게이트가 아직 held일 때만, 옵션 결정은 세션이 여전히 awaiting이고 에코된 `question`이 현재와 일치할 때만(1시간 전 인덱스가 새 프롬프트를 누르는 사고 차단). 적용은 WS와 같은 `handleDeviceCommand` 디스패치. ack된 결정은 상태 무관 단말적(기기가 삭제).
- 인증은 `/apme` 패턴(로컬 무료, LAN은 `?token=`). vitest 16케이스 + 전체 1957 green. **Swift 데몬 패리티는 명시적 이연** — client-contract 문서에 Node-only라고 기록.

### 포크 쪽 — Explore가 뒤집은 전제 2개와 그 귀결

1. **X3/X4 모두 ESP32-C3 단일 바이너리** (S3 아님). ext1 없음 + **전면 4버튼은 ADC 래더(GPIO1/2)** → 딥슬립 웨이크 소스는 **타이머+전원버튼(GPIO3)뿐**. 전면 버튼으로는 절대 깨울 수 없다.
2. **기존 `startDeepSleep`은 배터리 래치(GPIO13)를 LOW로 끊는 완전 전원 오프** — RTC 도메인까지 죽어 타이머 웨이크 불가. → `startTimedDeepSleep`: 래치를 **HIGH로 hold**한 채 타이머+GPIO 웨이크 armed(대기 전류 증가는 설정 opt-in 대가). RTC_NOINIT에 wake-instant epoch 추정을 실어 부팅 즉시 settimeofday → "as of" 정직성이 sync 전에도 유지.

구현: `feed_client`(GET/POST, `Protocol::applyCardFeed`가 sessions_list와 **같은 파스 초크포인트** 공유) · `outbox_store`(deck_store 관용구: magic+recordSize 스키마 버전, drop-oldest) · **엔드포인트 캐시**(데몬 ip:port+token은 원래 RAM-only여서 매부팅 재발견했음 — pull wake는 캐시 먼저, 실패 시 discovery 폴백; 9120→9139 동적 포트라 캐시는 advisory) · `card_class.h`(데몬 classifySessionCard 미러, 호스트 gtest) · deck Record에 actionClass 영속(캐시된 live 행="Reconnect to act · …", Open 힌트는 Connected에서만).

Cadence 흐름: 타이머 웨이크 + "AgentDeck battery sync" 설정 on + boot-to-card + 배터리 → WiFi 백그라운드 join → sync 1회 → 리페인트 → 20s linger(버튼=인터랙티브 전환) → `nextPullSec` 타이머 슬립. WiFi/데몬 실패는 예산(60s) 소진 후 unsynced 슬립 — **무인 웨이크는 절대 피커/스캔에 갇히지 않는다**. 인터랙티브 모드는 5분 idle 후 cadence 인계하되 **어떤 세션이 사용자를 기다리면 Face를 라이브로 유지**(버튼이 못 누르는 얼어붙은 프롬프트는 attention 계약 위반). 설정 기본 OFF — OTA만으로는 행동 불변.

### 검증

- 포크: pio 빌드 green, 호스트 gtest 95/95.
- 데몬 실서비스 검증: `/feed` 200(카드+actionClass+nextPullSec 900, 활성 세션 감지), `/outbox` 3케이스(unknown_card/applied/expired) 계약대로.
- 재시작한 9120 데몬이 행 상태였음(20:47 기동분, /health 무응답) — kill 후 새 dist로 재기동하니 전 보드 재접속.
- 딥슬립 cadence는 **하드웨어 전류/래치 거동 미검증** — 래치 hold 시 실제 슬립 전류와 타이머 웨이크 성공 여부는 설정 켠 실기에서 확인해야 한다(다음 세션 항목).
- **OTA 배포 대기**: 세션 종료 시점에 X3·X4 모두 오프라인(데몬 /devices 18분 미등장 — 전원 꺼진 듯). 최종 펌웨어 ef8f9154가 `firmware/update.bin`에 스테이징돼 있음 — 보드가 켜지면 `agentdeck esp32-ota xteink_x4 --firmware ~/github/crosspoint-agentdeck/firmware/update.bin` (x3 동일) 후 재접속 buildHash로 판정.

### 전원 재인가 후 배포전 — 플랩 공진 포렌식과 안정성 수정 (AgentDeck c733570f + 포크 d5c62148)

보드를 켜자 X4는 ef8f9154 OTA 성공(재접속 buildHash 판정), X3는 "접속 직후 사망" 플랩. 추적 결과 세 겹:

1. **데몬 O(n²) 초기버스트**: `buildCappedTimelineHistory`가 엔트리마다 이벤트 전체를 재직렬화(+예산 소진 후에도 계속 측정) — 타임라인이 자란 저녁엔 접속 1회당 수십 ms 동기 CPU. 플랩 클라이언트와 공진하면 이벤트 루프 포화(`sample`로 실측: stream read+llhttp 70%). → 증분 바이트 계산 + 조기 break.
2. **미태그 보드에 12KB 버스트**: 퍼스트파티 esp32 펌웨어는 `?clientType=esp32`로 접속해 보드 취급을 받는데 **XTeink 포크는 태그 누락(re-port 드리프트)** — 힙이 가장 빠듯한 X3(SD CJK 폰트 캐시)가 접속 직후 12KB 프레임에 OOM→closе→재접속 루프. → (a) 보드행 ≤4096B 불변식을 WS 초기버스트에도 적용(`ESP32_INITIAL_TIMELINE_HISTORY_MAX_BYTES=3584`), (b) 포크에 태그 추가, (c) **board-IP 기억**: device_info를 보낸 적 있는 IP는 다음 접속부터 첫 바이트부터 보드 취급(태그 없는 구펌웨어도 두 번째 접속부터 보호).
3. **플랩 가드 + 펌웨어 쿨다운 사다리**: 데몬은 30s에 >6회 재접속 IP의 히스토리 버스트를 스킵(서비스는 유지 — 거부하면 복구 중 보드가 영원히 눈멂); 펌웨어는 단명 연결 3연속 시 30s 재접속 중지 + "Link unstable" 상태줄(캐시 Face 유지).

판정과 남은 것: **X4 = d5c62148 라이브**(M6 전체+안정성 스택). **X3 = 6ccbe140 잔류** — 최종 원인은 앱이 아니라 **유닛 고유 RF 손실**(같은 위치의 X4 정상, X3만 SYN_RCVD 12s+ 고착 = 핸드셰이크 패킷 손실; USB도 죽은 그 유닛). 5.4MB OTA가 손실 링크를 못 넘음 — 기회주의 재시도 루프 가동, 실패 시 File Transfer 웹 업로드가 확실한 경로. 참고: 저녁 내내의 "보드 침묵"은 대부분 병렬 세션의 데몬 stop/start 사이클과 데몬 행이 겹친 것 — 보드는 "Connecting" 상태줄로 정직하게 반응하고 있었다. 마지막 퍼즐(9b4ae457): 유휴 표시전용 보드는 설계상 앱 메시지를 안 보내므로 메시지 기반 lastSeen이 건강한 보드를 "stale"로 낙인 — X4 "행" 추적에 한 시간을 쓰게 한 표시 왜곡. WS pong(15s 주기)을 로스터 liveness로 집계하도록 수정, X4가 무발신 40s 후에도 stale=False로 실증.
