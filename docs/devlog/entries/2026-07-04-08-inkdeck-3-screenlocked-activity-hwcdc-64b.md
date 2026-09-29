# 2026-07-04 — InkDeck 라운드 3: 브랜드 마크 교정 + screenLocked 래치 + activity 카드 + HWCDC 64B 드롭

### 사용자 피드백 → 수정 (커밋 71308024, 4581f31b, 7a125921)
1. **"asleep인데 데몬은 실행 중"** → 패널 정상, 데몬 버그. macOS가 잠금 해제 시 ioreg `CGSSessionScreenIsLocked` 키를 **삭제**(No로 안 바꿈)하는데 파서가 부재=undefined로 방치 → 한 번 잠그면 `screenLocked=true` 영구 래치 → 전 패널 슬립 고착. + 실키는 `k` 접두사(`kCGSSessionOnConsoleKey`)라 매칭 자체도 실패. fix: IOConsoleUsers 보이면 잠금 키 부재=UNLOCKED + `k?` 접두사 허용. 실검증 `/display-state` true 복구.
2. **"구형 로고"** → AD 실드는 SD/SD+ 시절 마크. 현행 = **돔+데크**(`AgentDeckLogo.swift`가 기하 SSOT, "older mark 대체" 명시). e-ink는 베지어 돔/워터라인/버블/3키 데크를 절차적으로 스트로크(`drawAgentDeckMark`). 실드 마스크 생성기 폐기.
3. **"IDLE 시간이 무의미"** → elapsedSec=세션 시작 후 경과라 "IDLE · 54m"가 오독됨. 카드에서 제거하고 **per-session activity one-liner**(bridge 공유 필드, X3와 동일)를 표시 — serial 경로 `prepareForSerial`에 activity 추가 + 펌웨어 파싱.
4. **"에이전트 많으면?"** → attention-first: awaiting/processing만 카드, 7개 이상이면 idle은 하단 IDLE 독(글리프+이름 칩 + "+N")으로 압축.
5. **"5H/7D 간격 없음, 버전 표시 불필요"** → 게이지 바 140px + "42% · 1h 23m" 결합 텍스트(블록 x=150/490), 버전 태그는 대시보드에서 제거(탐색 화면에만).

### HWCDC 전송 무결성 (검증 중 발견, 실측 기반)
- **RX 2048 < 8세션 sessions_list 2215B** → 인바운드 트렁케이션(`JSON error: InvalidInput`). INKDECK RX 8192.
- **HWCDC TX가 단일 println 중간에서 정확히 64B(HW FIFO 1블록) 드롭** — device_info 7/10 오염, flush는 악화. 드라이버 레벨 버그. GxEPD2 `init(115200)` 진단 출력(Core 1)도 오염원이라 `init(0)` 필수. fix: `Net::serialWriteJsonLine()` — INKDECK은 60B/드레인 페이싱(9/10 무결, 잔여는 데몬 identify 재시도가 흡수), UART 보드는 println 유지. 후보 후속: TinyUSB 모드(`ARDUINO_USB_MODE=0`) 실험.
