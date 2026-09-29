# 2026-07-04 — TRMNL BYOS 전면 제거 → InkDeck 커스텀 펌웨어 전환 + 정렬/색상 SSOT 수렴

### 배경
- inkterface(SteamOS e-ink 모니터) 소스 분석에서 나온 개선 제안 검증 → "snapshot+commit 계층 신설"은 TRMNL frame-cache에 이미 존재, "collector registry 신설"은 기존 shared SSOT 드리프트가 진짜 문제로 판명.
- 물리 패널의 정체가 리테일 TRMNL이 아니라 **Seeed TRMNL 7.5" OG DIY Kit**(XIAO ESP32-S3 Plus + GDEY075T7/UC8179 800×480, 상시 USB 급전)로 확정. stock 펌웨어의 deep-sleep→WiFi 재접속→HTTP 폴링 모델이 "WiFi connected 화면 회귀" 증상의 구조적 원인(매 wake가 재접속 기회=실패 기회)이라 BYOS 유지 대신 **커스텀 펌웨어로 전환** 결정. 기기명 **InkDeck**으로 재명명.

### 작업 (커밋 4개)
1. `07d8e221` **SSOT 수렴**: dead `d200h-renderer.ts` 삭제(임포터 0), `d200h-layout.ts` 로컬 sort→canonical `sortSessions`+`foldCodexSessionsForDisplay`(D200H/Ulanzi 순서가 SD/Apple/Android와 일치), state 색상 5중복→`STATE_COLORS` 파생(TUI ansi truecolor, Pixoo 셔머 튜플, hook-server 인라인 페이지 2곳).
2. `c71044bd` **Node/shared TRMNL 제거**: bridge/src/trmnl/* + 모듈 + `/api/setup|display|log`·`/trmnl/image` 라우트 + `agentdeck trmnl` CLI + `trmnl-layout.ts` + 테스트 5파일.
3. `88192bc7` **Swift/문서**: TrmnlModule/ImageRenderer/Settings + TrmnlHealth 모델/파서/DeviceEntry kind 제거(xcodegen 재생성, BUILD SUCCEEDED). 문서 전반 TRMNL→InkDeck.
4. `d03d9836` **InkDeck 펌웨어 + 브리지**: `env:inkdeck`(pioarduino S3, GxEPD2), `ui/eink/` 직접 드로잉(콘텐츠 해시 게이트, partial 8회/30분마다 풀 리프레시, awaiting 반전 밴드, 크리처 A8 실루엣, 5H/7D 게이지), `boards/board_inkdeck.h` 핀맵. **WS device_info 발신**(기존 serial 전용 → WiFi 보드가 데몬에 미등록되던 갭 해소) + 데몬 `esp32-wifi` 레지스트리(/devices) + **15초 display_state WS 재브로드캐스트**(serial 하트비트 자가치유의 네트워크 등가물).

### 검증 / 미검증
- vitest 1600 pass · bridge tsc · `pio run -e inkdeck` SUCCESS(RAM 41.7%/Flash 22.4%) · `xcodebuild AgentDeck_macOS` BUILD SUCCEEDED.
- **실기 미검증**: 패널 플래시(`pio run -e inkdeck -t upload`) 후 partial refresh 고스팅 품질·핀맵 확인 필요. 사용자 settings.json의 고아 `trmnl` 블록은 무해(수동 정리 가능).
