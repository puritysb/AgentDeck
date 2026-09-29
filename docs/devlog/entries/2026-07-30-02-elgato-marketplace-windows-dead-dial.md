# 2026-07-30 — Elgato Marketplace Windows 설치 회귀: 선언 복원에 그치지 않고 dead dial 제거

Doug의 #88 보고로 공개된 Stream Deck 1.0.2가 `OS.mac`만 선언해 Windows
Marketplace 설치를 막고, 이전에 로컬 링크한 정상 플러그인까지 비활성화한다는
사실을 확인했다. 이는 `docs/windows.md`의 bridge/hooks/plugin Windows 11
지원 계약과 충돌한다. 1.0.0 제출 준비 때 Volume과 Launcher가
`osascript`/`open -a`에 묶였다는 이유로 Windows를 통째로 제거한 결정이
원인이었다.

Stream Deck 채널을 1.0.3으로 올리고 `OS.windows`를 복원했다. 설치만 허용해
두 dead dial을 되살리는 대신 호스트 제어를
`plugin/src/utility-modes/system-control.ts`로 통합했다. macOS는 기존
volume readback과 실행 중 브라우저 탭 focus를 유지하고, Windows는 기본
Windows PowerShell의 media key로 volume/mute를 제어하며 Start Apps에서
Launcher 대상을 찾은 뒤 URL로 fallback한다. 사용자 정의 launch target은
PowerShell 소스에 보간하지 않고 환경 변수로 전달한다. Windows에는 안정적인
내장 Core Audio readback API가 없으므로 LCD는 거짓 퍼센트를 표시하지 않고
`Turn dial`/`Muted` 상태만 표시하며 polling process도 만들지 않는다.

플랫폼 dispatch/명령 비보간/volume tick coalescing/manifest 양 OS 계약을
테스트로 고정했다. 관련 24개 테스트, plugin typecheck, 전체 workspace build,
전체 Vitest 126 files/2,115 tests, version/docs gate가 통과했다. Elgato CLI
validator와 pack도 성공했고 결과물은 `1.0.3.0`, macOS 26+ + Windows 10+
manifest를 포함한다. 실제 Windows 설치·media key·Launcher 실기는 Doug의
환경에서 Marketplace 수정본으로 최종 확인한다.

---
