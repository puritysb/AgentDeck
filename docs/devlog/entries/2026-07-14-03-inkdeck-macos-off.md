# 2026-07-14 — InkDeck은 macOS 모니터 off에도 대시보드 유지

### 문제
macOS의 모니터 끄기 단축키/잠금/디스플레이 sleep은 공통 `display_state{displayOn:false}`를 모든 기기에 정상 전파한다. LCD/OLED/LED는 이를 full-off 또는 최소 밝기로 적용해야 하지만, 상시 USB 급전 e-ink인 InkDeck 펌웨어도 같은 이벤트에서 대시보드를 `asleep` 카드로 덮고 패널 controller를 `hibernate()`했다. 이는 이미 Android e-ink 경로에 정립된 “e-ink는 화면을 끄지 않는다” 정책과 불일치했고, e-ink의 무전력 화면 유지 특성상 유용한 상태를 숨길 실익도 없었다.

### 해결
- InkDeck 렌더러에서 host display-off 전용 sleep 카드/hibernate/wake full-refresh 분기를 제거. `display_state` 수신 자체는 공통 프로토콜 파리티를 위해 유지하되 InkDeck 렌더링은 `hostDisplayOn`을 무시하며, Mac 본체가 깨어 있는 동안 들어오는 실제 대시보드 변경은 계속 부분/전체 refresh한다.
- host simulator에 `display-off` 장면을 추가해 InkDeck의 `idle` 장면과 byte-identical PNG인지 회귀 확인할 수 있게 하고, `docs/devices.md`에 기기별 display-sleep 정책을 명시.
- repo deploy SSOT/`esp32/scripts/flash.sh`에 빠져 있던 `inkdeck` 명시 타깃을 추가. helper의 build→upload 이중 `pio run`은 BUILD_EPOCH 재주입 때문에 전체 펌웨어를 두 번 빌드하므로 upload target 1회로 통합.

### 검증
`pio run -e inkdeck` 펌웨어 빌드와 host simulator `inkdeck` 빌드 성공. simulator의 `idle`/`display-off` 출력 PNG SHA-256 일치로 모니터 off가 InkDeck 픽셀을 바꾸지 않음을 확인. 실기 `device_info`로 `inkdeck`/XIAO MAC `1c:db:d4:74:f4:d8`를 확정한 뒤 플래시. 다단 USB hub의 CDC/esptool 전송은 재열거 후 끊겼지만 built-in USB-JTAG OpenOCD 경로로 merged 1.6MB image write + read-back **Verify OK**, 정상 flash boot 복귀. Swift daemon serial health에서 `/dev/cu.usbmodem1CDBD474F4D81`, `board:inkdeck`, `version:0.2.3`, connected 재등록 확인.
