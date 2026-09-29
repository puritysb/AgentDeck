# 2026-07-21 — ips10 "계속 재부팅"의 진범: wedged CH340 를 데몬이 매분 재open 해 DTR 리셋

### 문제

ips10(P4+C6, `ffc5ed9f` 빌드, WiFi-only)이 계속 재부팅한다는 리포트. WS 세션 수를 시계열로 재보니 ips10만 3~7 사이로 요동하고 나머지 5개 WiFi 보드는 내내 `=1` 안정 — 전-데몬 storm 이 아니라 ips10 단독 flap. 5개 소켓을 동시에 유지한다는 것 자체가 "단순 MCU 리부트 루프"를 배제했다.

### 진단

ips10 CH340(`wchusbserial21110`)이 **wedge** 상태였다: 데몬은 `open timed out`, 데몬을 내리고 직접 pyserial 로 열어도 `errno 22` 즉사 — 어떤 소프트웨어도 못 여는 하드웨어 먹통(전원 사이클만 복구). 그리고 `ESP32Serial.swift` 는 open-timeout 을 EACCES 가 아니라 transient 로 분류해 **60s cap 으로 무한 재시도**했고, 매 `open()` 은 DTR/RTS 를 토글해 **보드를 리셋**한다(코드 주석이 이미 명시). 즉 데몬이 열 수도 없는 포트를 매분 재open 해 멀쩡한 보드를 리셋 = "계속 재부팅". 부차적으로 실행 중이던 데몬이 stale 바이너리(디스크의 Release 빌드는 이미 삭제됨)여서 flap 을 증폭했다 — HEAD 재빌드·스왑으로 줄었으나 재open 리셋은 그대로였다. 사용자가 USB 를 재연결하자 wedge 가 풀리며 정상 open → poke 소멸 → 안정. 원인 소멸이 증상 소멸로 이어져 진단이 역으로 확증됐다.

### 해결

- **Swift (#77)**: open 연속실패 ≥4 면 백오프 cap 을 60s→300s 로 승격(reset-poke 1/분→1/5분), 포트가 detect 목록에서 사라지면 실패기록 clear(재삽입 즉시 재시도). cadence 를 `openFailureBackoff` 순수함수로 추출 + XCTest 로 램프 고정.
- **Node (#79, closes #78)**: 리뷰에서 Node 브릿지도 open-실패 백오프가 전무(매 10s poll 재open)함을 확인 — foreign denylist 는 식별실패 전용이라 미적용. `serialOpenFailureBackoffMs` 로 동일 cadence 미러 + `openFailures` 맵 + vitest.

### 핵심 설계 결정

- wedge 자체는 소프트웨어로 못 푼다 → 코드는 "리부트 빈도만 낮추는" 역할, 시리얼 복구는 물리 전원 사이클. 이 경계를 문서·주석에 명시.
- 백오프 cadence 를 순수함수로 양 데몬에 미러하고 **각각 테스트로 고정**해 드리프트를 막았다(Swift XCTest ↔ Node vitest 동일 표).
- 부팅루프 진단 원칙 재확인: ping 손실률로 RF 를 단정하지 말 것(storm 의 증상), 단일보드 vs 전보드 동시성으로 계층(데몬/프레임 vs 물리) 판별, "재부팅"은 uptime/backtrace 로 WS flap 과 구분. 남은 것: wedged CH340 에서 Node 경로가 실제 보드 리셋을 유발하는지 실기검증(코드만으론 미확정).
