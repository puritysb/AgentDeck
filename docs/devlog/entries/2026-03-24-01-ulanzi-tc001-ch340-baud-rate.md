# 2026-03-24 — Ulanzi TC001 플래싱 실패 복구 (CH340 baud rate 문제)

### 문제
Ulanzi TC001 펌웨어 플래싱이 비정상 종료. 재시도 시 esptool이 firmware.bin 기록 ~9% 지점에서 "The chip stopped responding" 에러로 반복 실패. baud rate 460800 사용 중이었음.

### 해결
- 빌드 아티팩트 점검: bootloader.bin, partitions.bin, firmware.bin 3파일 정상, 최신 소스 반영 확인
- baud rate를 **115200으로 하향** → full flash (3파일) 성공, 71초 소요
- 부팅 검증: WiFi 자동 연결, mDNS daemon 발견, LED matrix 정상 동작

### 교훈 / 핵심 설계 결정
- **CH340 USB-UART는 460800 baud에서 불안정** — ESP32-S3 Native USB CDC와 달리 CH340은 높은 baud rate에서 데이터 손실 발생. Ulanzi TC001 플래시 시 **115200 baud 필수**
- 비정상 종료 의심 시 firmware만이 아닌 **bootloader+partitions+firmware 3파일 full flash**가 안전
- esptool CLI deprecated 문법 정리: `esptool.py` → `esptool`, `write_flash` → `write-flash`, `--flash_mode` → `--flash-mode`

---
