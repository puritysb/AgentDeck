# 2026-07-04 — Timebox Mini: 데몬 재시작 후 대시보드 미전환 자가치유 + micro 패널 활동 표현 강화

### 문제
1. **데몬 재시작 시 Timebox가 기본 시계 모드에 고착**(기기 전원 재투입해야만 대시보드 복귀). 원인: 데몬이 비정상 종료되면 고아가 된 Python BLE sync 자식(`sync_ble.py`)이 **작별 blank 프레임**(전-검정)을 그리는데, 그 시점이 후계자(재시작된) 데몬이 대시보드를 다시 그린 **직후**라 후계자 프레임을 덮어씀. stateful 패널 + dedup(`last_key`)로 재-push가 안 일어나 고착. 유일한 자가치유 경로가 "기기 전원 재투입 → BLE disconnect → `last_key` 리셋"이라 전원 재투입이 필요했음.
2. **micro 글리프가 정지 상태**(특히 Claude 로봇 `work`==`idle`이라 무애니메이션), Codex `>_`가 오프화이트 1px라 LED 디퓨저에서 배경/구름에 뭉개짐.

### 해결
- **후계자 인지형 작별** (`sync_ble.py`·`sync.py`·`matrix_sync_common.py`): 종료 사유 추적(`signal`/`orphan`/`bridge_gone`) + 신규 `bridge_reachable()`. 부모 사망(orphan)인데 브리지가 다시 응답 = 후계자 존재 → **작별 페인트 생략**(BLE clean disconnect는 유지해 single-central 링 해방). iDotMatrix OFFLINE 패리티 동일 적용.
- **하트비트 재-push** (`sync_ble.py`, `HEARTBEAT_SEC=8`): 콘텐츠 불변이어도 8초마다 강제 재전송 → RF 글리치·중첩 창으로 유실된 프레임이 전원 재투입 없이 수 초 내 자가치유. `push_micro_frame`이 실제 전송 여부(`sent`) 반환.
- **활동 표현** (`micro-glyphs.ts` SSOT → Swift 미러 재생성): Codex `>_` 순백·2px 볼드(작업 시 커서 blink), Claude 로봇 `work` 프레임(작업 시 시안 눈 점등+다리 stride), processing 배경 breathing(느린 파란 심박), OpenCode 링 pulse. idle은 정지 유지, awaiting amber 펄스 유지.

### 핵심 설계 결정
- **SIGKILL orphan reaper 채택 안 함**: SIGKILL은 BLE half-open(원래 버그) 재유발, SIGTERM reap은 작별-clobber 재유발. clean-disconnect + 하트비트가 더 견고.
- animFrame은 10fps지만 디바이스는 ~1.5s 폴링 재-push라, 빠른 포즈 애니보다 **느린 breathing 배경 + 상태별 확실히 구분되는 포즈**가 체감 신호. breathing은 프레임을 계속 변화시켜 dedup-lock 자가치유에도 유리.
- `TimeboxProtocolTests.swift`가 이미 stale(현 글리프에 없는 amber 눈/D 관절 검증)이던 것을 현 미러에 맞게 정정.
- 검증: vitest 1650 pass, `swiftc -parse` OK, `scripts/micro-preview.mjs`로 렌더 시각 확인. **실기기 디퓨저 체감 + XCTest 실행은 미확인**.
