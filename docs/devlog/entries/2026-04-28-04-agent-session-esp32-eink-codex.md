# 2026-04-28 — Agent Session 캐릭터 스케일 / ESP32-eink Codex 정합성

### 문제

직전 Agent Session 캐릭터 교체 이후 Codex cloud 는 방향성은 좋았지만 D200H/Stream Deck 축소 렌더에서 Claude/OpenClaw 보다 시각적으로 커 보이고 일부 컨테이너에서 살짝 잘려 보였다. OpenClaw 는 공식 실루엣을 단색으로만 축소해 눈과 얼굴이 읽히지 않아 붉은 덩어리처럼 보였다. ESP32 LVGL Codex 는 주석과 달리 6-lobe cloud 가 아니라 12×10 pill glyph 로 렌더되어 e-book/Android/D200H 와 캐릭터 언어가 어긋났다.

### 해결

- shared SVG session renderer 의 Codex cloud 유효 body scale 을 0.78 로 줄여 lobe 외곽이 48px icon box 안에 들어오게 했다.
- D200H CoreGraphics renderer 도 동일한 Codex body scale 을 적용하고 renderer revision 을 `creature-session-icons-v23` 으로 올려 캐시를 무효화했다.
- OpenClaw session icon 은 공식 24×24 실루엣의 body/claw path 를 유지하되, eye path 를 별도 dark eye + cyan highlight 로 렌더해 작은 버튼에서도 얼굴이 읽히게 했다.
- Android e-ink Codex lobe 값과 주석을 6-lobe cloud 기준으로 정리했다.
- ESP32 LVGL `Cloud::render` 를 pill glyph 에서 6-lobe cloud + `>_` prompt 로 교체했다.
- ESP32 flash helper 의 `auto` 경로가 다중 보드 응답 시 빈 env 로 진행하려는 문제를 수정하고, macOS `cu.wchusbserial*` 포트도 `device_info_request` 안전 식별 대상에 포함했다.
- Ulanzi TC001(CH340)은 460800 baud 업로드 중 응답이 끊겨 `upload_speed=115200` 을 env 기본값으로 고정했다.

### 검증

- `pnpm --filter @agentdeck/shared typecheck` 성공
- `pnpm --filter @agentdeck/plugin typecheck` 성공
- `pnpm vitest run plugin/src/__tests__/renderer-snapshots.test.ts -u` 성공 (1 file / 55 tests, snapshots 2 updated)
- `pnpm build` 성공
- `pio run -e box_86` 성공
- `bash scripts/build-android-release.sh` 성공 → `dist/agentdeck-v0.4.1.apk`
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataCharacterUX CODE_SIGNING_ALLOWED=NO` 성공 (기존 generated `GatewayFrame.JSONNull.hashValue` warning 은 남음)
- `streamdeck validate plugin/bound.serendipity.agentdeck.sdPlugin` 성공
- `pnpm package` 성공 → `dist/bound.serendipity.agentdeck.streamDeckPlugin`
- Stream Deck plugin link/restart 완료, macOS Debug app 재시작 완료, D200H status `rendererRev=creature-session-icons-v23` 확인
- 최신 D200H `set_buttons` dump 를 `pnpm d200h:preview` 로 변환해 contact sheet 확인
- Android/e-book 연결 기기 3대(Pantone6, CremaS, Lenovo tablet)에 `dist/agentdeck-v0.4.1.apk` 설치 및 `MainActivity` 기동 완료
- ESP32 4대(`ips_35`, `round_amoled`, `box_86`, `ulanzi_tc001`) 모두 명시 env+port 로 플래시 완료. TC001은 첫 PIO 업로드가 66%에서 끊겨 115200 baud direct esptool 로 재시도, hash verified.
- `bash -n esp32/scripts/flash.sh`, `pio run -e ulanzi_tc001`, `git diff --check` 성공
- macOS Debug app 재기동 후 daemon status: D200H connected, Stream Deck plugin process running, ESP32 serial `connectionCount=4`

---
