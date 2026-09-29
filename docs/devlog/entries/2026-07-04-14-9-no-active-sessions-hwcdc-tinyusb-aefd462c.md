# 2026-07-04 — 라운드 9: "no active sessions" 근본원인 = HWCDC → TinyUSB 전환 + 태스크 단위 로그 (커밋 aefd462c)

### 진단 여정 (증거 기반)
1. 데몬 debug: sessions_list 25회 브로드캐스트, 쓰기 에러 0 — 송신은 정상.
2. device_info에 **리얼리티 카운터**(sessionCount/timelineCount) 추가 + 하트비트 60s 재식별 → `/devices`로 포트 안 뺏고 보드 내부 상태 관측 가능해짐. 측정: 데몬 90초 후에도 sessionCount=0.
3. 실제 prepared sessions_list 라인(1.3KB, 유효 JSON) 직주입 → `[Protocol] JSON error: IncompleteInput` 재현 — **인바운드 트렁케이션**. HWCDC가 아침에 확인된 아웃바운드 64B 드롭과 대칭으로 **수신 방향도 드롭**(풀듀플렉스에서 확률↑; ack-per-line이 악화 요인).
4. **`ARDUINO_USB_MODE=0`(TinyUSB USB-OTG CDC) 전환** → out 10/10, in burst 5/5, 실데몬 90s **sessionCount=7** 완치. 포트명 MAC 기반 `cu.usbmodem1CDBD474F4D81`로 변경(스캔 패턴 매치). USBCDC엔 TX knob 없음 → HWCDC 전용 가드.

### 로그 품질 (사용자 지적: "명령어 다 뿌리지 말고 태스크 단위로")
- 데몬 훅 방출을 **chat_start(사용자 프롬프트)만**으로 축소 — 라운드 7의 per-tool tool_exec("Bash: cd /Users/…") 제거. 태스크 그룹핑은 APME task_start/end 몫.
- InkDeck 티커는 **마일스톤 타입만**(chat/task start/end) 표시 — tool 행·JSON 본문 제외.
- heartbeat_ack는 keepalive에만 응답(기존: 모든 인바운드 JSON마다 → 상시 TX).
- "no active sessions"의 이전 관측 일부는 플래시/재시작 윈도우의 일시 화면 + /devices 카운터가 연결직후 화석이었던 것도 혼재 — 60s 재식별로 해소.
