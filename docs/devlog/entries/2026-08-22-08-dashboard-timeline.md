# 2026-08-22 — Dashboard 세션 목록은 Timeline의 공간을 침범하지 않는다

macOS Dashboard 왼쪽 `SessionListPanel`은 오른쪽 `TopologyRail`과 달리 높이 예산이 없었다.
그래서 10개로 잘라 보여주고도 프로젝트 group header, 두 줄 이름, activity 행이 쌓이면
자연 높이가 아래 35%를 소유한 Timeline 위로 내려왔다. `MonitorHUD`가 이제 양쪽 카드에
같은 water-region 예산(`Timeline 시작점 - 상단 12pt - 여백 12pt`)을 전달하고, 세션 카드는
그 안에서만 자연 높이 또는 독립 스크롤 높이를 갖는다.

가로 폭은 Dashboard에 따라 220–280pt로만 늘려 긴 이름의 불필요한 줄바꿈을 줄였다.
7개부터 이름을 한 줄로 줄이고 행 간격·메타 글자를 소폭 압축하지만 정보 축은 유지한다.
기존 `maxVisibleSessions = 10`과 `and N more...`는 제거했다. 이제 임의의 첫 N개가 아니라
전체 roster가 같은 카드 안에서 스크롤되며, 긴 이름은 hover help로 원문을 확인할 수 있다.
실제 10개 세션 데이터에서 별도 `Agent sessions` scroll area, 마지막 두 세션 접근,
Timeline 비침범, 맨 위 위치 복원을 확인했다. 이 시각 검증에서 조건부 Setup 카드가
좌하단의 긴 roster를 덮는 2차 충돌도 발견해, landscape에서는 roster 폭을 기준으로
그 오른쪽에 배치하고 portrait/세션 목록 숨김 상태만 기존 14pt inset을 유지한다.

검증: macOS XCTest 665개(2 skip, 0 failure), 신규 Dashboard layout 정책 4개,
전체 TypeScript build, 디자인 시스템 29문서/99토큰/53에셋, macOS Debug build 통과.
