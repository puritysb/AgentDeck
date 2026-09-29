# 2026-07-17 (밤) — TTGO T-Display offline layout overflow fix and serial flashing

### 문제
- TTGO T-Display 기기가 offline 상태(데몬과 미연결 상태)일 때, 화면 중앙에 표시되는 AgentDeck 로고와 연결 카드(connCard)가 135x240 LCD 액정 경계를 벗어나서 잘리는 등 화면 밖으로 넘치고 뭉개지는 레이아웃 어색함이 있었다.
- 또한, 기기가 USB Serial에 연결되어 있을 때 firmware가 WiFi 라디오를 자동으로 파킹(WiFi off)하므로 WiFi OTA를 통한 펌웨어 업데이트가 불가능했다.

### 해결
- **레이아웃 개선**: [esp32/src/ui/screens/aquarium.cpp](esp32/src/ui/screens/aquarium.cpp)를 수정하여 TTGO 보드(`BOARD_TTGO`)의 컴팩트 세로 화면(width 135)에 맞게 `connCard` 너비를 화면 가로 길이에 연동(`g_screenW - 16`, 최대 260)하고 패딩을 줄여 좌우 8px의 여백을 깔끔하게 유지하게 했다.
- **방향 대응**: 화면 세로 길이가 150px 미만인 가로 모드 상황을 감안해 레이아웃 플로우를 세로(`COLUMN`)에서 가로(`ROW`) 형태로 동적 전환하여 로고와 텍스트를 좌우 배치함으로써 컴팩트 액정에서의 상하 오버플로우를 완전히 제거했다.
- **폰트 최적화**: 좁은 액정에 적합하도록 카드 제목과 상태 메시지 폰트를 Montserrat 14/12로 줄여 가독성을 높였다.
- **업로드 속도 튜닝**: [esp32/platformio.ini](esp32/platformio.ini) 내 `[env:ttgo]`의 시리얼 플래시 업로드 속도를 `57600`에서 표준적이고 훨씬 안정적인 `115200`으로 2배 상향 조정했다.
- **시리얼 플래싱**: 데몬을 잠시 종료해 포트 점유를 해제한 뒤 `pio run -e ttgo -t upload`를 수행하여 USB Serial로 펌웨어를 성공적으로 안전하게 주입했다.

### 검증
- **시뮬레이터 렌더**: `esp32/sim/render.sh`를 활용해 `ttgo` 타겟의 `empty`(offline) 및 `idle`(connected) 씬을 렌더링하고, 생성된 `ttgo-empty.png`, `ttgo-idle.png`를 visual inspection하여 135x240 화면 경계 내에 모든 요소가 비율을 맞춰 완벽히 배치되는 것을 확인했다.
- **기기 실측**: 데몬 재기동 후 TTGO 보드의 시리얼 handshake와 WiFi 자동 프로비저닝(`wifi_provision_ack` 수신) 및 WiFi AP 연결 수립 상태(`wifiConnected: true`, `wifiConfigured: true`)를 확인했다.
