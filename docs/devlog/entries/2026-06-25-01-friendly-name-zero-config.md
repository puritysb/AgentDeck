# 2026-06-25 — 디바이스 friendly-name 일치 점검 + zero-config 자동 발견

### 문제
"연동 기기 이름이 `docs/hardware/index.html` friendly명과 일치하는가" + "남이 설치해도 기기 속성을 자동 감지해 같은 타입으로 매핑되는가" 점검 요청. 라이브 데몬(`/health`) 대조 결과 두 갭: ① Swift 표시명 switch(`TopologyRail`/`MenuBarTopologyList`)에 `ttgo_t_display`·`esp32_c6_147` 케이스 누락 → raw 와이어 문자열로 노출(TTGO 가 실제 연결 중인 라이브 버그). 네이밍 체계 4종(wire/flash.sh/Swift/HTML)이 SSOT 없이 분산. ② self-advertise 하는 기기(ESP32 device_info·Stream Deck SDK·TRMNL BYOS·Android EinkDetector)는 자동 매핑되지만 **Pixoo·Timebox·iDotMatrix 는 수동 IP/MAC 입력**이라 신규 설치 시 안 잡힘.

### 해결
- **네이밍**: 누락 케이스 추가 + AMOLED/86 Box/IPS 10.1 라벨을 HTML friendly 열에 맞춤(두 Swift switch 동기, 중복 주석 명시). `shared/src/protocol.ts` 와이어 타입힌트 7-board 완성.
- **자동 발견**: Pixoo 는 mDNS 없음 → 로컬 /24 **서브넷 스윕**(`Channel/GetAllConf`→`Brightness` 프로브) 신설. **Node**(`pixoo-discover.ts`) + **App Store Swift**(`PixooModule.autoDiscoverIfNeeded`, URLSession+getifaddrs, 서브프로세스/외부서비스/권한프롬프트 없음) 양쪽. BLE(Timebox/iDotMatrix)는 **Node 만** 부팅 자동스캔(기존 bleak `scan*.py` 재사용, `*-discover.ts`). 공통: 0대일 때만 auto-add + `*AutoDiscover` opt-out.

### 핵심 설계 결정
- **Swift BLE 부팅-자동스캔 의도적 제외.** `CBCentralManager` 생성이 *모든* App Store 사용자에게 Bluetooth 권한 프롬프트를 강제 → 기기 없는 사용자까지 묻게 됨. 현재 데몬은 BLE 기기 설정한 사용자에게만 lazy-create. 그래서 Swift BLE 발견은 설정 시트의 **사용자 트리거 Scan** 유지, Node CLI(프롬프트 무관)만 부팅 자동스캔. plan 승인 범위에서 벗어난 유일한 의도적 deviation.
- **actor 직렬화 회피.** `PixooModule.postCommand` 는 actor-isolated → 254-host 직렬 스윕은 수 분. 스윕 프로브를 `nonisolated` + per-host ephemeral URLSession 으로 빼 실제 동시성 확보(concurrency 32, 600ms timeout).
- **Pixoo 발견은 클라우드보다 로컬 우선.** Divoom 클라우드 LAN API 는 외부 서비스 → App Review 마찰. 로컬 스윕이 App-Store-clean. 클라우드는 Node fallback 으로만.

---
