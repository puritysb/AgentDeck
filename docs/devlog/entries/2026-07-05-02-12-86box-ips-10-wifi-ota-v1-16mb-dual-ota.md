# 2026-07-05 — 라운드 12: 86box 및 ips_10 WiFi OTA v1 지원 확장 (16MB dual-OTA 파티션 적용)

- **86box 및 ips_10 OTA 지원**: 물리 플래시가 16MB임에도 4MB 및 factory 단일 파티션으로 설정되어 WiFi OTA 대상에서 제외되었던 `86box`와 `ips_10` 기기에 OTA v1을 활성화.
- **파티션 레이아웃 변경**:
  - `86box` (ESP32-S3 16MB)용 `partitions/box_86_ota.csv`를 신설하여 dual-OTA 슬롯(각 ~7.75MB) 배치.
  - `ips_10` (ESP32-P4 16MB 실물 플래시 확인)용 `partitions/jc8012p4a1c_ota.csv`를 신설하여 dual-OTA 슬롯(각 ~6.0MB) 배치.
- **platformio.ini 설정**: `rgb48`, `box_86`, `ips10` 환경의 `board_build.flash_size`/`board_upload.flash_size`를 16MB로 선언 및 파티션 테이블을 각각 신규 `*_ota.csv`로 교체. `NO_OTA=1`을 제거하고 `HAS_OTA=1`을 활성화.
- **빌드 검증**: `pio run -e box_86` 및 `pio run -e ips10` 빌드를 각각 실행하여 컴파일 성공 및 바이너리가 dual-OTA 파티션 크기(box_86: 7.75MB, ips10: 6.0MB)에 정상적으로 안착함을 확인.
- **실기 USB 마이그레이션 및 daemon 감지 검증**: `86box`는 `/dev/cu.wchusbserial21110`에 dual-OTA 펌웨어 업로드 완료(1421KB compressed) 후 daemon에서 `86box v0.1.2 (f82f4616-dirty) OTA 7.8MB`로 감지. `ips_10`은 `/dev/cu.wchusbserial201240`에서 clean build 후 업로드 완료(1350KB compressed) 및 daemon에서 `ips_10 v0.1.2 (f82f4616-dirty) OTA 6.0MB`로 감지. 두 실기 유닛 모두 `otadata` + `app0/app1` layout 마이그레이션 완료.
