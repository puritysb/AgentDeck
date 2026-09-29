# 2026-08-23 — 두 번째 결함은 첫 번째 뒤에 숨어 있었다: master red 와 preview 미러 포팅

### 문제

master 가 `CHANGELOG.md has no section for esp32 1.0.8` 로 red 였다. fae46ef0 이
FIRMWARE_VERSION 을 1.0.7 → 1.0.8 로 올리면서 CHANGELOG 섹션을 남기지 않았고, 그 섹션이 곧
GitHub Release body 라 게이트가 막은 것이다.

그런데 그걸 고치자 **두 번째** 실패가 드러났다: 같은 커밋이 `eink_display.cpp` 와
`matrix_pages.cpp` 를 바꾸면서 Swift preview 미러의 SYNC-HASH 핀 2개를 갱신하지 않았다.
CI 의 `test` job 은 vitest 단계에서 죽었고 `Preview mirror sync check` 는 **그 뒤 단계**라
한 번도 실행된 적이 없다. master 는 두 결함을 안고 있었지만 로그에는 하나만 보였다.

### 해결

- CHANGELOG 에 ESP32 1.0.8 섹션 추가. 내용은 diff 가 아니라 fae46ef0 이 자기 devlog 에 쓴
  기록에서 옮겼다.
- 두 미러를 실제로 포팅하고 핀을 파일에서 재계산(`git hash-object`)해 갱신했다.

### 핵심 설계 결정

**"mid-pulse" 규약은 정규화된 envelope 을 0.5 로 평가하는 것이다.** MatrixTerminalPreviews
는 애니메이션을 정지 프레임으로 미러링하는데, 그 값이 무엇인지 어디에도 적혀 있지 않았다.
역산으로 확정했다 — Claude `(125,75,56)`, Codex `(65,65,160)`, Kiro `(98,60,174)` 가 모두
`pulse = 0.5` 에서 정확히 나오고, 펌웨어의 Kiro 주석이 그 대응을 명시적으로 못 박고 있다.
awaiting 은 이 규약을 벗어나 있었는데(`0.3+0.7*sin` 에 sin=0.5 를 대입한 값), 펌웨어가
`wave = 0.5+0.5*sin` 로 정규화되면서 규약과 다시 맞았다: `0.45+0.55*0.5 = 0.725` →
`(145,87,0)`.

**`drawStateDot` 은 미러에 영향이 없다 — 확인해서 아는 것이지 추측이 아니다.** 호출부가
`renderUsage` / `renderCodex` 뿐이고 미러는 AGENTS 페이지만 그린다. 게이트가 요구하는
"영향 없음 확인"은 이렇게 호출부를 세어서만 할 수 있다.

**InkDeck 미러는 우선순위·정원·hidden 헤더를 아예 구현한 적이 없었다.** 수동 모드
sessionCount 가 {0,1,2,4} 로 고정이라 정원(6)을 넘을 수 없었고, 넘지 않으면 세 기능 모두
아무 픽셀도 바꾸지 않는다. **표면이 그 코드를 한 번도 실행하지 않으면 미러가 드리프트한
사실 자체가 보이지 않는다** — 그래서 10세션 live 스냅샷 씬(`inkdeck-dense-hidden`)을
영구 아티팩트로 추가했다. 펌웨어가 같은 이유로 10세션 `dense` 시뮬레이터 씬을 둔 것과
같은 대응이다.

그 씬이 곧바로 두 가지를 더 잡았다. 헤더 문자열이 길어져 잘릴 수 있는데 펌웨어는 폰트를
낮춰 대응하므로 미러도 `minimumScaleFactor` 로 줄이게 했다(잘라내면 추가한 이유인 tally 가
사라진다). 그리고 파일 주석의 "the first awaiting card inverts" 는 **틀린 서술**이었다 —
`drawSessionCard` 는 `awaiting` 으로 분기하고 `firstAwaiting` 은 tall 카드의 옵션 목록만
게이트한다. 수동 모드가 awaiting 카드를 둘 이상 만들지 못해 반증될 기회가 없었을 뿐이다.

**계측기부터 검증했다.** 스냅샷 하네스가 `TEST SUCCEEDED` 를 냈지만 PNG 는 7월 11일자
그대로였다 — env 가 러너에 닿지 않아 XCTSkip 이 난 것을 성공으로 읽을 뻔했다. 출력 경로를
찍어 확인한 뒤에야 렌더된 그림을 봤다.

---
