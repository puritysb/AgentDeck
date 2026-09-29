# 2026-07-11 — Swift 데몬 기기 자동연결 실패 근본수정 (BLE 데드락 · Pixoo 세션 고착 · WS 메인큐 굶주림)

### 문제
Swift 데몬 실행 중 Timebox Mini/iDotMatrix가 15시간째 `statusReason:"connecting…"·lastError:null·로그 0줄`로 무음 고착, Pixoo64는 살아있는데(외부 curl 즉답) 백오프에서 영영 못 나옴, Android 태블릿은 WS 접속 폭주/등록 0건 churn(앱 CPU 94.7%). 태블릿은 별도로 "usb connect"에 갇혀 `ws://127.0.0.1:9120`만 반복 시도.

### 해결
- **BLE 데드락** (`aae72d9a`): `withTimeout`의 task group은 timeout 자식이 throw해도 work 자식 종료를 await하는데, CB delegate 콜백만이 resume할 수 있는 continuation은 취소 비인지라 콜백 부재 시(TCC 미결정/기기 OFF — CB connect는 자체 타임아웃 없음) 영구 데드락 → `isPushing` 가드가 모듈 전체 동결. 모든 continuation을 `withTaskCancellationHandler` + queue-confined cancel-pending 플래그로 cancellation-aware화, connect 취소 시 `cancelPeripheralConnection`, CB state/authorization 진단 로그 추가.
- **BLE 환경 트리거**: TCC Bluetooth 레코드가 서명 전환기 빌드의 **cdhash에 고정** → 재빌드 후 `authorization=notDetermined`인데 stale 레코드가 재프롬프트도 차단. `tccutil reset BluetoothAlways bound.serendipity.agent.deck` 후 재실행으로 identity 기반 새 허용 획득(재빌드에도 유지).
- **Pixoo 자가치유** (`aae72d9a`, `6fb8566f`): 장수 URLSession NW 고착 시 fresh-세션 sweep이 같은 IP의 생존 기기를 찾으면 `rebuildURLSession()`+backoff 해제(기존엔 relocated 아니라고 조용히 폐기), deep-hang 경계에서도 세션 재생성. 브레이커 상수를 주석이 주장하던 Node 값으로 실제 정렬(threshold 1→6, cap 300→60s).
- **Android USB 갇힘** (`6fb8566f`): 자동연결이 localhost(USB)→저장URL→6초 mDNS 창 순환이라 Swift 데몬(adb reverse 없음)에선 USB 시도에 갇힘. 상시 mDNS collector가 데몬 발견 즉시 localhost 시도를 선점(매 연결 재resolve — 데몬 재시작 후 stale 포트도 치유).
- **WS/UI 구조** (`d11a297e`): NWListener/NWConnection이 `.main`에서 돌아 SwiftUI layout이 send-completion을 굶주림("64 in flight"=갇힌 completion) → 전용 직렬 큐로 이전. 타임라인 행 분류 정규식 재컴파일을 static 컴파일+NSCache 메모이즈로, `@Published state` 필드별 ~40회 publish를 로컬 복사 후 단일 대입으로. 30s 연속 포화 클라이언트는 cancel 축출.
- **android-dashboard 토폴로지** (`148ae3f6`): WiFi 태블릿이 익명 소비자라 행이 없던 갭 — `client_register{clientType:"android-dashboard"}` volunteer-roster를 Android 송신 + 양 데몬 캐시/evict-on-close + TopologyRail Android 섹션으로 신설(feature-matrix 선등재).

### 핵심 설계 결정
- **timeout 헬퍼 안의 모든 continuation은 cancellation-aware가 계약**: 구조적 동시성의 task group은 취소된 자식도 종료를 기다리므로, delegate-resumed continuation이 하나라도 취소 비인지면 timeout이 영구 hang으로 역전된다 (CLAUDE.md "External peer async I/O" 원칙의 코어 케이스).
- **fresh-세션 probe 성공 = "네트워크 정상, 내 세션 고장" 신호**로 취급해 세션 재생성으로 자가치유 — "restart AgentDeck" 수동 권고 제거.
- 데몬과 UI가 한 프로세스인 이상 **NW I/O는 절대 .main에 두지 않는다**.
- WiFi 클라이언트 가시성은 volunteer-roster(`client_register`) 모델로 통일 (Stream Deck/XTeink/android-dashboard 동형).

### 검증
4개 기기 전부 라이브 복구·자동 재연결 확인(데몬 재시작/기기 OFF→ON/force-stop 축출 각 시나리오 실기), Lenovo TB-J606F 토폴로지 행 스크린샷 확인, 앱 CPU 94.7%→25~28%, saturation 로그 15h 연속→0. bridge vitest 1168 green, macOS XCTest 전체 green.

---
