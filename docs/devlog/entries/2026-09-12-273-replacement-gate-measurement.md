# 2026-09-12 — #273 대체 게이트 중 소스로 답할 수 있는 둘을 측정했다

[#273](https://github.com/puritysb/AgentDeck/issues/273)은 managed PTY 제거 전에
네 개의 대체 게이트를 요구한다. 이 중 remote attach와 세션 순서는 완료 조건에
실제 2대 토폴로지와 실사용자 시나리오 검증을 명시하고 있어 소스 읽기로는 닫을 수
없다. 나머지 둘 — 커스텀 실행 인자, 터미널 전용 갭 — 을 `3f7dc473` 기준으로
측정하고 [docs/managed-replacement-inventory.md](docs/managed-replacement-inventory.md)에
남겼다. 카탈로그에는 결정을 담지 않은 측정 문서이므로 exclusion으로 등록했다.

## 이슈 표의 두 행이 실측과 달랐다

토큰 텔레메트리를 "daemon-first 대체재 없음"으로 적어둔 행은 토큰에 관해서는 틀렸다.
`passive-observer.ts:328-333`이 transcript에서 `input/output/cache_read/cache_creation`을
합산하고 `contextPercent`까지 만들며, 두 값 모두 와이어(`protocol.ts:504`)와
D200H 레이아웃(`d200h-layout.ts:691`)에 도달한다. Codex도 같은 경로가 있다.
실제로 터미널에만 있는 것은 **턴 지속시간**(`usageTracker.setDuration`의 유일한 공급원이
`status_line` 파싱이다)과 상태줄 텍스트 자체다. `usage_info`는 Claude `/usage` 출력의
스크레이프이고 데몬은 같은 데이터의 1급 클라이언트를 이미 갖고 있으므로 중복 출처다.

"resume-command composition"은 AgentDeck 기능이 아니었다. 저장소 전체에서 resume
빌더를 찾지 못했다. resume은 사용자가 `-c`에 쓰는 텍스트이고, 우리 의무는 env append가
그것을 덮어쓰지 않는 것뿐이며 그 보장은 이미 테스트되어 있다.

## 표에 없는 두 축

`-c`는 argv 배열이 아니라 **셸에 넘기는 명령 문자열**이다. `pty-manager.ts:98-103`은
POSIX에서 `$SHELL -l -c`, Windows에서 `cmd.exe /d /s /c`를 쓴다. `-l`은 로그인 셸이므로
사용자 프로파일이 먼저 적용된다 — 에이전트 바이너리를 직접 exec하는 대체재는 플래그는
재현하지만 PATH와 버전 매니저를 조용히 잃는다.

observed 키 주입(`observed-inject.ts:373`)은 tmux → iTerm2 → Terminal.app → 앱 호스트의
4단 사다리인데 2~4단이 `osascript`다. 즉 macOS이거나 tmux가 있어야 한다. Windows와
tmux 없는 Linux에는 주입 경로가 없다. 게이트 표에 플랫폼 축이 없다.

## switch_mode는 죽은 컨트롤이 아니었다

훅도 API도 주입 단도 없으므로 observed 행에 아무것도 하지 않는 버튼이 떠 있을
가능성을 의심했으나 아니었다. 라이브 세션 데크(`buildSessionDeck`)는 모드 명령을 아예
내지 않고, `mode_toggle`을 내는 MODE 타일은 폐기된 direct-HID 그리드(`computeLayout`)에
있으며, 남은 모드 버튼은 `startSession` 안에서 만들어지므로 그 세션은 정의상 managed다.
결론은 "부분 지원"보다 날카롭다: 오늘 `switch_mode`는 managed 세션 자신의 데크에서만
도달 가능하므로, managed 경로 제거는 이 기능을 격하가 아니라 **삭제**한다.

Swift 데몬에는 아직 `mode_toggle` 핸들러(`DaemonServer.swift:4847`)가 남아 있다. 라이브
레이아웃이 그 명령을 내지 않으므로 실행되지 않지만, 읽는 사람에게는 observed 모드 전환이
동작한다는 증거처럼 보인다.

## 게이트가 요구한 픽스처

"대표 설정의 회귀 픽스처를 추가하라"는 항목에서 계약의 핵심 절반이 비어 있었다. 어떤
셸인지, 어떤 스위치인지, 문자열이 손대지 않은 채 도착하는지를 아무것도 고정하지 않고
있었다. `pty-manager-launch-contract.test.ts`는 node-pty를 목으로 두고 실제 `spawn()`을
구동해 로그인 셸·fallback·win32 스위치·문자열 원문 전달을 고정한다. 순수 헬퍼가 아니라
조합자를 덮으므로 이후 `spawn()` 수정이 우회할 수 없다. `cli.test.ts`에는 weave가 사용자
따옴표·`&&`·Windows 경로·따옴표 친 env 값을 건드리지 않는다는 케이스를 넣었다.

초록이라는 이유로 믿지 않고 변이로 확인했다. `-l` 제거, 명령 JSON 이스케이프, weave 값
따옴표 처리 셋 다 새 케이스를 빨갛게 만든다. 전체 4,467개 통과, 1개 기존 skip.
