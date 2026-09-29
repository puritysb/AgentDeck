# 2026-06-07 — Mobile Reconnect & ESP32 CDC Connection Stabilized

### 문제

1. **Android/iOS Reconnecting Loop**: 모바일 기기가 Dead Port(9121)나 이전 잘못된 포트에 물려 있을 때, Wifi 접속 실패 후 mDNS 재탐색으로 넘어가지 못하고 무한 Reconnecting 루프에 갇히는 현상이 발생했다.
2. **ESP32 Native CDC 기기 무한 리셋**: `/dev/cu.usbmodem*` (round_amoled, ips_35 등) 기기가 화면 렌더링은 잘 되지만 read 트래픽이 없어 데몬에서 20초마다 오프라인(`stale`)으로 판단하여 연결을 닫았다 다시 여는 현상이 있었다.
3. **D200H**: 데몬이 기동될 때 활성 세션(Claude Code 등)이 없으면 메인 ZIP 이미지가 전송되지 않아 기기가 Stock 펌웨어 대기화면(crayfish 캐릭터)에 멈춰 있었고, macOS TCC 보안 정책으로 인해 Node-HID가 Keyboard Interface를 열지 못해 버튼 이벤트가 유실되어도 관련 오류가 표출되지 않고 있었다. 또한, macOS 상의 `node-hid` 에서는 Output Report ID가 필요하지 않은 HID 기기에 쓰기를 할 때 첫 번째 바이트에 `0x00` 패딩(Report ID)을 붙이지 않으면 OS HID 드라이버가 임의로 데이터의 첫 번째 바이트를 제거해버려 D200H 기기 상에서 ZIP 패킷의 `0x7C 0x7C` 헤더가 깨지며 화면이 아예 갱신되지 않고 굳어버리는 버그가 있었다.
4. **Unit Tests**: Claude subscription quota 체크 규칙으로 인해 일부 bridge-core 테스트 케이스가 실패했다.

### 수정

- **Android 클라이언트 (`BridgeConnection.kt`)**: Wifi URL 포함하여 연결이 5회 연속 실패하면 내부 URL을 클리어하고 Reconnect 시도를 중지시켜, mDNS 백그라운드 재탐색을 즉시 유도했다.
- **iOS 클라이언트 (`BridgeConnection.swift`)**: 모든 URL의 최대 재연결 시도를 20회에서 5회로 줄여, 잘못된 Wi-Fi 데몬 주소에서 빠르게 빠져나오고 mDNS 재탐색을 실행하도록 했다.
- **ESP32 Serial 모듈 (`esp32-serial.ts`)**: CDC 디바이스(usbmodem 또는 ttyACM)는 DTR/RTS 신호 제한으로 read 트래픽이 없어도, 최근 쓰기(`write`)가 성공했고 디바이스 정보 캐시가 존재하면 활성 상태(`isResponsive` -> true, `stale` -> false)로 간주하고 강제 재연결을 면제했다.
- **D200H 계측 & 기동 수정 (`d200h-module.ts`)**:
  - D200H 연결 직후 세션 유무와 무관하게 즉시 초기 OFFLINE/대기 대시보드 레이아웃을 렌더링(ZIP 패킷 전송)하여 대기화면에 멈추는 문제를 해결했다.
  - Keyboard Interface 오픈 에러 발생 시 catch 블록에서 `lastOpenError` 에 명시적으로 'macOS Input Monitoring Permission' 안내 문구를 기입하여 진단 가능성을 극대화했다.
  - macOS 환경인 경우, HID 키보드 오픈 권한 실패 시 최초 1회 시스템 설정의 '입력 모니터링' 보안 패널(`x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent`)을 자동으로 호출해 사용자의 권한 획득을 가이드하도록 개선했다.
  - `node-hid` write 시 첫 번째 바이트에 `0x00` (macOS Report ID dummy) 패딩을 추가 전송하여, OS 드라이버에 의한 D200H 프로토콜 헤더(`0x7C 0x7C`) 깨짐 현상을 근본적으로 해결했다.
- **Unit Tests (`bridge-core.test.ts`)**: Claude subscription 검증 통과를 위해 테스트 스테이트 머신에 Claude 모델 명칭을 명시적으로 기입했다.

### 검증

- `pnpm test`로 1,276개 전체 유닛 테스트의 성공을 확인했다.
- `pnpm build`로 패키지 모노레포의 빌드 무결성을 확인했다.
- `adb` 및 `streamdeck` 툴을 통해 모바일 기기(Pantone 6, Lenovo Tab) 배포와 Stream Deck 플러그인 링크 배포를 자동으로 진행했다.
- `agentdeck daemon start` 후 `agentdeck devices` 확인 결과:
  - Android 기기 2대(Crema S 포함)가 reverse tcp 포트(9120)를 타고 실시간 WebSocket으로 즉시 자동 연결됨.
  - `round_amoled`와 `ips_35`를 포함한 총 6개의 ESP32 디바이스가 `stale: false`, `connected: true`로 안정적으로 연결 유지됨.
  - D200H 기기가 정상 감지되어 0x00 패딩이 추가된 초기 대시보드 렌더링 ZIP 패킷 송출(writeOK 누적)을 성공적으로 수행했으며, `lastOpenError`에 macOS Input Monitoring 권한 에러 메시지 및 `resvgLoaded: true` 진단 상태가 정상 표출되는 것을 확인.

---
