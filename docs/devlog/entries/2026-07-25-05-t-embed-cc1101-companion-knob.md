# 2026-07-25 — T-Embed CC1101 "Companion Knob" 승격: 플릿 최초의 양방향 입력 보드

### 배경
두 Evaluation 보드(T-Embed CC1101, T-Display-S3-Pro)의 활용 컨셉을
[docs/esp32-companion-concepts.md](docs/esp32-companion-concepts.md) 로 문서화한
뒤, 같은 날 T-Embed 거치 조향 노브 MVP 를 구현·실기검증까지 완료했다. 핵심
전제는 "데몬 9120 에는 조향 어휘(`focus_session`/`navigate_option`/
`select_option`/`session_command`)가 이미 완비되어 있고, 로터리 엔코더는 정확히
그 어휘 모양의 입력장치"라는 것 — 코어 조향에 신규 명령 타입이 하나도 필요
없었다.

### 구현 (env `t_embed`, commit 7004b2a5)
- **2-레벨 노브 UI** (`esp32/src/ui/knob/`): 리스트 = 회전으로 세션 순환,
  press 로 진입; 디테일 = 상태 의존 메뉴(awaiting=세션별 실제 옵션+Esc,
  processing=STOP, idle=Go on), 회전=커서, press=확정, long-press=BACK.
  Stream Deck 세션 데크 문법의 엔코더 번역.
- **인코더 드라이버** (`esp32/src/input/`): ISR 풀 상태테이블 쿼드러처 디코드
  (1 디텐트=4 카운트, 프레임 경계 잔여분 보존) + 짧게/길게(600ms) 판별.
- **WS2812 링 8구**: 세션별 시맨틱 상태색, amber awaiting 만 애니메이션
  (DESIGN 규칙 4), 커서 하이라이트, display-sleep 시 소등.
- **세션별 옵션 파싱**: `SessionInfo.options[6]` 추가. 양 데몬 모두
  `prepareForSerial` 이 세션별 `question`/`promptType`/`options` 를 이미
  통과시키고 있어 **데몬 수정 없음**. `requestId` 는 양 데몬 다 미전송 —
  승인/거부는 ips10 과 동일한 `select_option(0)`/`escape` 폴백.
- 보드 헤더/파티션(16MB dual-OTA 6MB)/ST7789 LGFX 브랜치/PWR_EN 배터리 래치.

### 검증 (2026-07-25)
- 미지 usbmodem 포트 신원확인 = **flash 바이트 비교**(K230 팩토리 이미지 일치).
  같은 방법으로 이웃 포트가 S3-Pro 임을 확정하고 16MB 팩토리 백업 캡처
  (256KB 청크 — 대용량 단일 read 는 이 유닛 USB CDC 에서 간헐 손상).
- serial `wifi_provision` 직접 주입 → mDNS 데몬 발견 → WS 등록 →
  sessions_list 3세션 파싱 확인. 화면/인코더/링/조향은 실기 확인.
- **WiFi OTA 왕복 검증**: `agentdeck esp32-ota t_embed --build` →
  buildEpoch 갱신 + `resetReason: software` 재부팅 확인.

### 문서 승격
Surface matrix +1 (Counted surfaces 22→23, README·랜딩 미러 동기),
스펙시트 Evaluation→Shipping (`t_embed`·`t_embed`, OTA 6MB), esp32.md OTA
표·포트 스냅샷, client-contract 보드 목록. **Partial 사유 = Swift 데몬 조향
미검증** (표시 파이프라인은 동일하나 라이브 왕복은 Node 만 확인).

### 남은 단계 (컨셉 문서의 gap 표가 체크리스트)
휴대 페이저(BLE 폰 릴레이, 배터리 보고=capability 광고 필요), 음성(wake word
부활→호스트 AI 스피커; 온디바이스 명령어 계층은 명시적으로 제외 결정),
peripheral primitives(NFC/IR/sub-GHz `peripheral_event`/`peripheral_command`),
Swift 데몬 조향 검증, T-Display-S3-Pro "Tide Ticker".

---
