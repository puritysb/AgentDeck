# 2026-08-30 — 기기별 OFFLINE은 하나의 문법을 쓰고 empty roster와 분리된다

Daemon Offline 표현을 기기마다 별도 예외로 그리던 경로를 연결 상태 정본에 맞춰
정리했다. 공통 문법은 emissive/color의 near-black 바탕(e-ink는 paper white), muted
cyan AgentDeck rail, 하나의 큰 상태행과 최대 하나의 보조행이다. 직접 연결하는
Apple/Android/ESP32는 실제 search/connect/
reconnect 단계를 말할 수 있지만, daemon이 밀어주는 수동 디스플레이는 수행하지 않는
재연결을 주장하지 않고 `OFFLINE`만 표시한다. 구체적인 연결 시도가 실패한 경우의
raw error는 retry/manual-connect 조작이 있는 직접 연결 화면에만 남긴다.

D200H는 가운데 한 키만 쓰던 offline 상태를 5×2 키 전체에 걸친 하나의 카드로 바꿨고,
어느 키를 눌러도 companion을 연다. 동시에 plugin→daemon transport 상태를 aggregate
session state와 분리하는 `daemonConnected`를 layout input에 추가했다. 따라서 daemon은
살아 있지만 session이 0개인 경우 더는 offline으로 오판하지 않고 `HUB READY` /
`NO SESSION` / `AgentDeck idle` 카드가 나온다. Ulanzi tutorial의 8개 locale도 실제
full-deck 동작으로 맞췄다.

T-Embed CC1101과 T-Display Pro는 같은 LVGL connection card를 사용하고, InkDeck은
`OFFLINE` retained sheet와 live-daemon `no active sessions`를 분리했다. 특히 InkDeck의
후속 refresh가 최초 offline sheet를 빈 roster로 덮던 실제 분기 오류를 수정했다.
TC001/Pixoo64/iDotMatrix/Timebox는 소비전력을 늘리는 offline animation 없이 정적이고
희소한 dark badge를 쓰며, 3×5 `N` glyph는 `M`과 같던 형태에서 명확한 대각선으로
교정했다. Node와 Swift renderer/preview mirror가 같은 픽셀을 생성한다.

검증: TypeScript/Vitest 238 files, 3,717 tests; macOS XCTest 707 tests(2 skipped),
Android v1.0.10 release APK; preview mirror sync 10 pins; T-Embed/T-Display Pro/
TC001/InkDeck host simulator offline frames. 네 ESP32 release 환경은 native
PlatformIO toolchain으로 빌드했다.

실기 배포는 daemon을 먼저 내려 수동 display가 passive offline 상태를 받게 한 뒤
T-Embed(`/dev/cu.usbmodem314401`), T-Display Pro(`/dev/cu.usbmodem21301`),
TC001(`/dev/cu.wchusbserial3130`), InkDeck(런타임 `/dev/cu.usbmodem1CDBD474F4D81`,
다운로드 `/dev/cu.usbmodem3111101`), NM-EPD-420(`/dev/cu.usbmodem83201`),
LilyGo EPD47(`/dev/cu.usbmodem21401`) 순으로 플래시했다. TC001은 115200 baud에서
bootloader/partition/app 전체를 기록했고, 모든 write hash가 검증됐다. 최신 shared/
bridge 빌드로 daemon을 재시작한 뒤 여섯 `device_info`가 모두
`3d975d47-dirty`, fresh/open transport로 재등록되는 것까지 확인했다.
