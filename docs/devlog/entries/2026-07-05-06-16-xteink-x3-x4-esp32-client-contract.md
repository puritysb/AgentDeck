# 2026-07-05 — 라운드 16: XTeink X3/X4 대시보드 등록 + ESP32 client contract + 프로젝트 클러스터 정리

### 배경
AgentDeck / crosspoint-agentdeck(포크) / OpenClaw 세 레포의 경계가 모호해진 것을 정리하고, XTeink X3/X4 를 macOS 대시보드에서 관제 가능하게 만듦. 핵심 정신모델: **2 제품 + 3 레포 + 양쪽 클라이언트 1 기기**. AgentDeck(에이전트 스티어링) / BabelForge(이중언어 책 파이프라인, OpenClaw 서 분리) 두 제품, 그리고 두 제품 모두의 클라이언트인 X3/X4 기기.

### 해결
1. **ESP32 client contract 공식화** — `docs/esp32-client-contract.md`(신규 SSOT): display-only 클라이언트가 지켜야 할 와이어 계약(inbound 이벤트, `device_info`/command 프레임). C/C++ 코드젠 없음(quicktype=Swift/Kotlin only, no-PSRAM ArduinoJson 불가) → 드리프트는 port-sync 규율로 관리(`docs/esp32.md`, 포크 `.skills/SKILL.md`).
2. **X3/X4 device_info 발신 구현** — 포크 `AgentDashboardActivity::sendDeviceInfo()`(`crosspoint-reader@07408ec9`), 보드 `xteink_x3`/`xteink_x4`, 단일 펌웨어 런타임 감지(`gpio.deviceIsX3()`). pio 빌드 [SUCCESS].
3. **디바이스 매트릭스 4표면 + Swift** — `esp32DisplayName` 케이스 추가, `protocol.ts` 정본 문자열, hardware-compat/appstore/devices/hardware.html 에 X4 추가 + 상태 갱신. macOS `xcodebuild AgentDeck_macOS` SUCCEEDED.
4. **BabelForge 분리** — `book_translator/`(OpenClaw 서 미추적)를 `~/github/BabelForge`(GitHub private) 로 이동 + git init; launchd `com.local.book-translator-watcher` 재지정; agent 스캐폴드(CLAUDE.md/AGENTS.md/`.agents/skills`) 셋업.

### 핵심 설계 결정
- ★**Dual-registration gotcha**: 두 데몬이 WiFi 기기를 **다른 메시지**로 등록 — **macOS Swift 데몬** = `client_register{clientType:"eink-device"}` → E-ink rail(포크가 이미 발신); **Node 데몬** = `device_info{board}` → `esp32-wifi`(board-agnostic, 아무 문자열 수용). 그래서 포크는 둘 다 발신.
- X3/X4 는 SD `update.bin` 플래시만 가능(USB-data 사망) → `otaSupported:false`, `esp32/` pio env 없음 → **WiFi OTA 대상 아님**(`ESP32_OTA_BOARDS` 미등록). 등록 자체는 board-agnostic 이라 무관.
- bilingual-EPUB 포맷 SSOT 는 소비자(포크 `docs/bilingual-epub.md`) 소유 유지; BabelForge=생산자.
- 미완: 포크 펌웨어는 **온디바이스 SD 플래시 대기**(하드웨어 수동 단계). 상세 맥락은 memory `project-cluster-two-products-babelforge.md`.
