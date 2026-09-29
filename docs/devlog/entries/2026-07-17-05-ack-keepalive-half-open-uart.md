# 2026-07-17 — 시리얼 보드 "무응답"의 정체: ack 된 적 없는 keepalive + 회수 불가능한 half-open UART

### 문제
CLI 데몬 점검 중 CH340 시리얼 보드 3 개(ips_10 / ulanzi_tc001 / ttgo)가 4–20+ 분씩 RX 침묵하는데 데몬은 `transportOpen: true, lastWriteSecondsAgo: 0` 으로 정상인 척했다. stale reaper 는 영원히 발동하지 않았고(자가치유 불능), native-CDC 인 inkdeck 만 멀쩡했다.

### 원인 (두 겹)
1. **keepalive 가 애초에 ack 된 적이 없다.** 펌웨어(`serial_client.cpp`)는 `strstr(buf, "\"keepalive\"")` 매치 라인에만 `heartbeat_ack` 를 회신하는데, Node 가 5 초마다 보내던 프레임은 `{"type":"serial_keepalive"}` — 부분문자열 불일치로 **단 한 번도 매치되지 않았다** (2cf5fc75 에서 도입된 명명이 펌웨어 계약을 못 봄). 즉 유일한 주기적 board→host 트래픽은 60 초 device_info refresh 뿐이었고, 응답 1 회 유실 = 1 분+ 장애처럼 보였다. `isResponsive` 의 60 초 임계와 정확히 경계가 겹쳐 `connected` 플래그도 만성적으로 플랩했다 (single-path dedup 의 입력이므로 WiFi WS 억제까지 흔들림).
2. **half-open UART 는 구조적으로 회수 불가.** reaper 의 UART 조항이 "read>60s **AND** write>60s" 를 요구하는데, heartbeat write 는 5 초마다 커널 버퍼에 성공적으로 들어가므로 writeAge≈0 이 영원히 유지된다. CDC 쪽엔 이 함정을 인지한 `isHalfOpenIdentifiedCdc` 가 있었지만 "연결 후 무읽기" 케이스만 커버 — **중도에 RX 가 죽은 UART** 는 좀비 FD 로 영구 보유됐다.

### 해결 (00c94bee — Node + Swift 세트)
- **Node**: keepalive 타입을 `keepalive` 로 (Swift 데몬이 이미 쓰는, 458fb1d3 이후 모든 배포 펌웨어가 ack 하는 프레임). `isSilentIdentifiedUart` 추가 — 식별된 UART 가 읽은 적 있고 RX 침묵 >180s 면 write 건강과 무관하게 recycle (재오픈의 DTR/RTS 토글 = 보드 리셋 = self-heal).
- **Swift** (`ESP32Serial.swift`): keepalive 를 **매 사이클 상시 발송**으로 (기존엔 "다른 페이로드가 없을 때만" — sessions_list/display_state 를 매 사이클 re-sync 하므로 활성 데몬에선 keepalive 가 사실상 발송된 적 없음 = 건강한 보드도 수신 0). 동일한 180s half-open recycle 추가.

### 핵심 설계 결정
- **liveness reaper 와 그 liveness 신호는 반드시 한 커밋으로.** Swift 에 reaper 만 넣었다면 (keepalive 상시화 없이) 활성 데몬이 건강한 보드를 3 분마다 DTR/RTS 리셋하는 더 나쁜 회귀가 됐다. 임계값(180s)은 신호 주기(3–5s ack)의 ~40–60 배로 잡았다.
- **write 성공은 peer 생존의 증거가 아니다** — 커널 버퍼가 받아줄 뿐. 시리얼 liveness 는 반드시 read 쪽으로 판단한다 (외부 peer async I/O 컨벤션의 시리얼 버전).
- 회귀 가드: vitest `serial keepalive ack contract` 가 프레임이 펌웨어 strstr 계약(`"keepalive"` 인용 부분문자열)을 만족하는지 고정.

### 검증
데몬 재시작 후 4 보드 전부 read age 0–9 초 안정 (수정 전: 60 초 주기 + 분 단위 갭). 잔여 관찰: 당일 13:21–13:26 에 보드 3 개가 동시기 재부팅(tc001=poweron, inkdeck=panic on 구빌드 0301e43d)한 것은 별건 — inkdeck panic backtrace 추적과 ttgo(0.1.2)/inkdeck 구펌웨어 최신화가 후속 과제.
