# 2026-07-12 — XTeink X4 약한 RF 링크 진단 · WiFi ESP32 topology flap 유예 확대

### 진단
- XTeink X4(`192.168.68.61`)가 Swift 데몬 WebSocket을 수십 초 간격으로 재연결하고 `Connection reset by peer`/timeout 뒤 roster에서 제거되는 현장을 확인했다. 동일 펌웨어(`1.4.1-dev-master-69fd5368`)의 X3는 안정적이었다.
- 같은 시점 ping 20회 비교: X4 손실 20%(평균 112ms, 최대 391ms), X3 손실 0%(평균 70ms), gateway 손실 0%(평균 0.57ms). 공통 데몬/펌웨어 버전 회귀보다 X4 위치·안테나의 2.4GHz RF 마진 문제가 직접 원인이다.
- 외부 `crosspoint-agentdeck`의 Agent Dashboard 경로는 Web Server/OTA 경로와 달리 `WiFi.setSleep(false)`를 적용하지 않는다. 실제 소켓 안정화 후속 후보는 dashboard 진입 동안 ESP32-C3 modem sleep을 끄고 종료 시 복원하는 것(외부 포크에서 별도 진행).

### 완화
- Swift `DaemonServer`의 WiFi ESP32 close-driven roster eviction grace를 10초→45초로 확대했다. 약한 RF에서 교체 소켓 등록이 10–30초 걸려도 topology에서 장치가 사라졌다 나타나는 churn을 막는다. 닫힌 소켓으로 이벤트를 보내지 않고 identity만 잠시 유지한다.

### 검증
- `xcodebuild build -project AgentDeck.xcodeproj -scheme AgentDeck_macOS -destination 'platform=macOS' -quiet` — BUILD SUCCEEDED(기존 경고만).
- `git diff --check` 통과.
