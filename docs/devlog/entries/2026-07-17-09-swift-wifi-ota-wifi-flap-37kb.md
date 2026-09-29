# 2026-07-17 — Swift 데몬 WiFi OTA 포팅 + WiFi 보드 만성 flap의 진범(37KB 단일 프레임)

### Swift 데몬 ESP32 WiFi OTA (commit `e2edaa27`)
Swift 데몬은 WiFi 보드를 받기만 하고 업데이트를 못 해서 OTA 때마다 Node 데몬으로 교체해야 했다. `ESP32WifiOta.swift`가 Node `performWifiEsp32Ota`를 포팅: otaId 기반 ack 라우팅, 단계별 timeout(begin 15s / chunk·end 30s), **reconnect-follow 재전송**(WiFi-flash 공존 드롭 시 새 소켓 추적, 최대 12회), abort best-effort. `POST /esp32/ota`는 `firmwarePath` 외에 **`firmwareB64` 인라인**을 받는다 — 샌드박스 데몬이 컨테이너 밖 경로를 못 읽는 경우의 경로로, CLI가 `firmware_unreadable` 응답에 자동 재전송(HTTP 바디캡은 이 라우트만 24MB). App Store 안전성: 서브프로세스 없음(펌웨어는 기기에서 실행되는 데이터), `--build`(pio)만 Tier 2 — feature matrix에 행 추가. 실측: Xcode Debug 샌드박스 데몬이 `~/github` 경로를 직접 읽었음(폴백 미발동이나 코드는 유지 — 서명/프로파일에 따라 달라질 수 있음).

### WiFi 보드 만성 flap — 근본원인은 fanout이 아니라 "프레임 크기 × 시각"
전 WiFi 보드(86box/ips_35/round_amoled/tc001)가 오후 내내 ~5초 주기 connect→choke→reconnect. OTA는 chunk ack가 계속 유실되며 실패(chunk #7, resend 소진). 야간 로그는 시간당 연결 2회(안정) — **flap은 콘텐츠 의존**이었다:
1. **connect burst의 timeline_history**: 64행 ring 캡은 있었지만 바이트 캡이 없어, 바쁜 오후의 한글 타임라인 64행 = **실측 ~37KB 단일 라인**. serial 펌웨어는 초과 라인을 침묵 폐기(무증상)하지만 **WiFi WS 클라이언트는 소켓을 끊는다** → 재접속 → 같은 프레임 → 무한 flap. 야간엔 타임라인이 비어서 프레임이 작아 안정 — "밤엔 멀쩡한데 오후에 미친다"의 실체.
2. **Swift sessions_list 무캡**: Node는 `SERIAL_SESSIONS_CAP=10`(roundRobinByAgentType)인데 Swift shrink는 관측 세션 전부를 실었다(다중 Claude 세션 오후에 증폭 요인).
3. **등록 레이스**: connect burst가 보드의 device_info 등록보다 먼저 발화하면 셰이핑 없는 풀 프레임이 나감. Node는 **WS 업그레이드 URL 쿼리(`clientType=esp32`)로 접속 즉시 태깅**하는데 Swift는 쿼리를 버렸다.

Fix (commit `9f6657e0`): timeline_history **바이트 예산 3500B**(최신 우선, 양 데몬 미러 `budgetTimelineEntries`) + Swift에 roundRobin 캡 포팅 + `WebSocketConnection.isEsp32`(업그레이드 라인 파싱)로 frame-zero 셰이핑/드롭. 검증: 로스터가 4보드 동시 안정(이전: 1대씩 순환), 90초 신규연결 4회(초기 접속뿐).

### 구펌웨어 4보드 최신화 — Swift 데몬 OTA 실전 검증
- **round_amoled** 7b81882f-dirty → `e2edaa27` OTA ✓ (2.4MB/2480 chunks) — Swift 데몬 첫 OTA
- **86box** 53794d2d-dirty → `e2edaa27` OTA ✓ (2.5MB/2543 chunks)
- **ips_35** 7b81882f-dirty → `e2edaa27` OTA ✓ (2.4MB/2495 chunks)
- **tc001** 5f0f4e52-dirty → `e2edaa27` serial 플래시 ✓ — 구펌웨어의 radio parking(serial 연결 시 WiFi off)으로 WS가 안 돌아와 OTA 불가; /diag의 82fbdfff 표기는 stale이었음(실측 5f0f4e52-dirty)
- 셋 다 재부팅 후 WiFi 재등록으로 buildHash 실측 검증. vitest 62/62(serial), XCTest ESP32WifiForwardTests 9/9. (전체 vitest의 timebox-ble 7건 실패는 동시 세션의 micro-glyphs 진행 중 작업 — 이 라운드 무관)
