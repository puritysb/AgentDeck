# 2026-07-31 (4) — hosted assert 근본 수정: mempool을 PSRAM으로

간헐 리부팅(Task #4)의 마지막 원인 규명과 수정. 계측이 결정적이었다:
device_info에 추가한 `largestFreeBlockKb`가 **총 여유 74KB에서 최대
연속 블록 31KB**를 보여줬다. 프리빌트 코어의
`SDIO_OPTIMIZATION_RX_STREAMING_MODE`는 수신 버스트를 하나의 큰 연속
할당으로 받는데, 단편화된 내부 힙이 그걸 못 주면 ESP-Hosted가 assert로
보드를 죽인다. 야간(작은 버스트) 무사 / 주간(멀티캐스트 소음, 큰 버스트)
크래시 패턴이 이걸로 설명된다.

수정 경로는 pioarduino의 `custom_sdkconfig`(Kconfig 델타로 Arduino
코어를 소스 재빌드). 시행착오 셋을 치렀다: ① choice 그룹은 `=n`으로
격퇴해야 한다("# ... is not set"은 ini 파서가 주석으로 삼킴) ② 플래시
지오메트리는 `board_upload.flash_size`가 SSOT(없으면 4MB로 리셋되어
16MB OTA 파티션 거부) + `f_flash`는 `L` 접미사 필수(없으면
"40000000m"라는 무효 주파수 생성) ③ 생성물 `sdkconfig.defaults`/
`sdkconfig.ips10`은 빌드 아티팩트 — 델타 변경 시 삭제해야 반영.
첫 시도 `RX_NONE`(패킷당 소형 할당)은 역효과: mempool이 해제 버퍼를
반환하지 않아 내부 힙이 82→10KB로 붕괴했다.

정답은 한 플래그였다: **`CONFIG_ESP_HOSTED_MEMPOOL_PREFER_SPIRAM=y`** —
assert를 내던 바로 그 할당자가 80KB 내부 힙 대신 32MB PSRAM에서 뽑는다.
RX는 stock STREAMING 유지. 결과(epoch 1785505562): 내부 힙 free 95KB
(+13), largest 48KB(31→48), WiFi/WS/HTTP 음성 경로 정상. 풀 고갈이
구조적으로 불가능해졌으므로 장기 관찰로 최종 확인한다.

---
