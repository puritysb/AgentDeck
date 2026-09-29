# 2026-08-06 — 답을 실어 보낼 필드가 없으면 거절 사유에 실어 보낸다: AskUserQuestion 원격 응답

### 문제

"기기에서 고른 선택이 hook 으로 에이전트까지 잘 전달되는지" 와 "여러 단계 선택일 때 다음
단계가 제대로 보여지고 입력되는지" 두 가지를 점검했다. 둘 다 깨져 있었다.

**Swift 앱 단독 모드에는 전달 경로 자체가 없었다.** 기기 탭은 `handleObservedClaudeCommand`
에서 "held gate 없음" 로그만 남기고 버려졌다. AskUserQuestion 은 양 데몬 모두 held-hook 게이트
대상에서 빠져 있고(`promptProneTools` 밖), Node 가 쓰던 터미널 키 주입은 샌드박스에서
불가능하기 때문이다. 의도된 설계였지만 결과는 **Stream Deck·D200H·macOS·Android 가 아무도
답할 수 없는 질문을 렌더**하는 상태였다.

**한 호출에 여러 question 이 담기면 두 번째 탭이 엉뚱한 항목을 골랐다.** Claude 는 한 번의
AskUserQuestion 에 최대 4개 question 을 담는데 양 데몬이 첫 group 만 wire 에 실었다. Node
주입 경로에서 Q1 에 답하면 TUI 는 Q2 로 넘어가는데 overlay 는 Q1 그대로 — 다음 탭이 **새
질문에 옛 인덱스를 주입해 무음으로 오선택**했다. 표시 쪽으로는 Ulanzi 가 두 질문을 같다고
판정해 재렌더를 건너뛰었고(`deckSignature` 에 세션별 question/options 없음), 세션을 열면
데몬의 전역 state_update 가 실제 질문을 덮었으며, 페이지 번호가 다음 질문으로 이월됐다.

### 해결

**hook 계약에 답을 공급하는 필드가 없다는 것부터 확인했다.** 공식 문서상 PreToolUse 출력은
`permissionDecision` allow/deny/ask + `updatedInput` 뿐이다. 그러나 **deny 의
`permissionDecisionReason` 텍스트는 모델에 전달**되고, 이 레포는 이미 soft STOP 과 턴엔드
지시큐에서 그 채널을 쓰고 있었다. 그래서 **ask-gate**: 데몬이 질문의 PreToolUse 를 붙잡았다가
사용자가 고른 항목을 사유로 실어 해소한다. 순수 HTTP hold 라 서브프로세스가 없다.

사다리는 네 단이 됐다 — managed PTY 키주입 → observed + 터미널 도달가능 시 주입 → **ask-gate
hold** → 표시 전용. **주입이 가능하면 hold 하지 않는다**: hold 는 그 터미널 앞에 앉은 사람을
기다리게 하므로, 다른 길이 없을 때만 쓴다.

다중 question 은 wire 를 flat 로 둔 채(`question`/`options` = 현재 group 투영) 데몬이 한
번에 하나씩 제시하고 답할 때마다 전진한다. `select_option` 에 선택적 `question` echo 를
추가해 지나간 질문에 대한 탭은 적용 대신 폐기하고 재브로드캐스트한다.

### 핵심 설계 결정

- **ask-gate 는 권한게이트의 정밀가드를 전부 건너뛴다.** 그 가드들은 "Claude 가 자동승인해서
  묻지도 않을 호출을 hold 하면 안 된다" 때문에 존재한다. AskUserQuestion 은 **항상 묻는다** —
  false-hold 가 원리적으로 불가능하므로 rule predictor 를 호출하지 않는다. 그 결과 `~/.claude`
  를 읽을 수 없어 권한게이트가 스스로 꺼지는 **App Store 샌드박스에서도 동작**한다. 조건은
  `enabled && clientCount>0 && 세션당 게이트 1개` 뿐.
- **타임아웃은 빈 응답(pass)** — Claude 의 픽커가 평소대로 뜬다. 과거 hold 설계를 "자동 진행
  원치 않음" 으로 거부했던 지점이 여기서 해소된다. 사용자를 대신해 진행하는 경로는 없다.
- **deny 하면 도구가 실행되지 않으므로 PostToolUse 가 오지 않는다** — overlay 를 데몬이 직접
  클리어해야 한다. 안 하면 세션이 awaiting 에 고착된다.
- **`liveAnswerable` 의 의미를 넓혔다**: "이 데몬이 이 세션의 답을 전달할 수 있다"(주입 또는
  ask-gate). 모든 표면이 이 하나로 누름 가능 여부를 판정한다. ask-gate 는 `requestId` 를 wire
  에 싣지 않는다 — 실으면 데크가 Allow/Deny 로 렌더해 4지선다가 이진 결정으로 붕괴한다.
- **group 을 평탄화하지 않는다.** 인덱스가 group 사이에서 의미를 바꾸므로, 하나의 인덱스
  공간으로 합치면 Q1 을 겨냥한 press 가 Q2 의 옵션을 고른다.
- **observed 세션은 state_update 채널이 없다 — roster row 가 SSOT.** `focus_session` 회신인
  데몬 전역 스냅샷이 그 세션의 `focusedSessionId` 로 스탬프되어 귀속 검사를 통과하고 실제
  질문/옵션을 덮었다. **Ulanzi `state-store.ts` 와 Stream Deck `focused-detail-state.ts` 양쪽에
  같은 버그**가 있었다.
- **`deckSignature` 누락 4번째.** 다중 question 전환은 `state`/`currentTool` 을 건드리지 않아
  서명이 같아진다. 세션별 question/options/askGroupIndex 를 넣고, app.ts 가 import 시 Studio
  소켓을 열어 테스트가 불가능했던 문제를 `plugin-ulanzi/src/deck-signature.ts` 순수 모듈 분리로
  풀어 회귀 게이트를 걸었다.
- PreToolUse curl 이 이미 `--max-time 60` 이라 hold 45s 는 **hook 스크립트 3중 미러를 건드리지
  않는다**.

### 검증

vitest 2646, macOS/iOS BUILD SUCCEEDED, Android `testDebugUnitTest`, docs/preview-mirror/
surface-mirror/design-system/version 게이트 전부 통과. `bridge/src/__tests__/ask-gate.test.ts`
는 데몬이 호출하는 실제 모듈을 실제 순서로 엮어 hold → 응답 → hook 본문까지 확인한다. 구현
중 `daemon-server.ts` 가 `httpServer.listen` 을 await 한 뒤에야 `passiveSessionObserver` 를
`const` 선언한다는 걸 발견해(기동 직후 도착한 hook 이 TDZ ReferenceError) 선언을 HTTP 서버
앞으로 올렸다.

**실기 검증 (같은 날 후속)**: tmux 안의 대화형 `claude` 를 프로그램으로 몰아 전부 확인했다.

- **deny-reason 은 답으로 통한다.** 격리 훅으로 ask-gate 본문을 그대로 돌려주니 픽커는 뜨지
  않고 Claude 가 `Error:` 로 reason 을 받아 **훅이 고른 값**(각 group 의 마지막 옵션)으로
  진행했다 — 단일/3-question 모두 재질문 없음. `FINAL = Blue/Dog/Winter`.
- **데몬의 다중 group 파싱과 전진이 실기에서 동작한다.** `sessions_list` 가 `grp=0/3` →
  `1/3` → `2/3` 로 TUI 와 동행했고, 지나간 질문 echo 로 보낸 press 는 폐기됐다.
- ★**계측 함정 2건**: `claude -p` 에는 AskUserQuestion 이 아예 없어(도구 목록에 부재) 헤드리스
  검증이 불가능하다. 그리고 첫 프로브는 `python3 -` 에 heredoc 과 stdin 을 동시에 물려 payload
  를 못 읽었다 — 훅은 정상 발화했는데 프로브가 조용히 죽어 "메커니즘 실패" 로 오독할 뻔했다.

**실기에서만 나온 버그 2건** (유닛 테스트가 볼 수 없는, 터미널이 키를 어떻게 처리하는가의
문제라 별도 커밋으로 수정):

1. ★**arrow 와 Enter 를 한 버스트로 보내면 픽커가 arrow 이전 커서로 Enter 를 해석한다.**
   `tmux send-keys Down Enter` 한 번 호출 = 항상 0번 옵션. "Blue" 를 눌러도 "Red" 가 선택됐다.
   실측: 배치 → Red, `Down` → 0.35s → `Enter` 분리 → Dog(정상). 텍스트 주입 경로에는 이미
   있던 페이싱이 선택 경로에만 빠져 있었다.
2. ★**grouped AskUserQuestion 은 마지막 답변으로 닫히지 않는다** — "Review your answers →
   Submit answers" 확인 화면이 뜬다. 사용자가 터미널에 없으니 아무도 못 누르고 에이전트가
   영원히 대기했다. 마지막 group 응답에만 Enter 를 하나 더 싣는다(단일 질문엔 그 단계가 없어
   추가 Enter 가 프롬프트 창에 떨어지므로 금지).

수정 후 재검증: 기기에서 3문항을 답하니 `colour → Blue, animal → Dog, season → Winter` 로
**누른 값 그대로** 들어가고 Submit 까지 자동으로 눌렸다.

**리뷰가 잡은 것 (머지 전 수정)**: 적대적 리뷰 2건을 돌려 실기 검증도 테스트도 못 잡은 결함을
찾았다. 공통 성질은 **조용히 틀린다**는 것 — 터미널이 비어 있거나, 아무도 고르지 않은 답이
확정된다.

- ★**"answer 는 자기가 답하는 질문을 지목해야 한다"**. ESP32 mosaic / NFC 태그는 하드웨어
  APPROVE 키를 `select_option(0)` 으로 매핑한다. 권한 게이트에선 의미가 있지만 4지선다에선
  추측이고, ask-gate 는 그것을 **사용자의 확정 답변으로 제출**해 버렸다. 이전엔 무해한 no-op
  이던 코드가 새 전달경로가 생기면서 위험해진 것 — `[[deck-mirrors-lag-device-firmware]]` 의
  반대 방향 사례다. 이제 `question` echo 없는 press 는 거부한다(진짜 선택지를 그리는 표면은
  지목할 수 있고, 이진 승인 키는 못 한다 — 정확히 원하는 경계).
- ★**hold 조건이 역전돼 있었다**. `injectable=false` 는 "이 터미널에 못 친다" 인 동시에
  "관측자 로스터에 없다"(스캔 전 5초, ps 실패) 이기도 한데, 후자는 **어떤 기기에도 안 보이는
  세션**이다. 즉 hold 가 걸리는 유일한 자연 발생 케이스가 아무도 답할 수 없는 케이스였다.
  로스터에 없으면 hold 안 함.
- **Submit 판정을 파싱 결과로 하고 있었다** — 버려진 malformed group 도 사용자 폼에선 탭이라
  `groups.length` 를 믿으면 확인 화면을 못 누르고 영구 대기. `rawGroupCount` 로 판정.
- macOS **메뉴바**만 `liveAnswerable` 게이팅에서 누락돼 죽은 버튼이 생겼다(대시보드 HUD·안드
  로이드 2표면은 고쳐놓고). 그리고 `advance` 가 끝을 지나서도 답을 계속 append 했다.
- ★**데몬 배선에 회귀 게이트가 없었다** — 리뷰어가 `daemon-server.ts` 를 통째로 master 로
  되돌려도 2648 테스트가 전부 통과했다. 판단 로직을 `bridge/src/ask-gate.ts` 순수 모듈로
  빼고 `ask-gate-decisions.test.ts` 로 덮었다(뮤테이션으로 실패 확인). 테스트 주석이 "실제
  배선을 구동한다" 고 주장하던 것도 사실대로 고쳤다.
- Swift ask-gate hold 기본값 45s→**20s**: 그 시간의 비용은 전부 터미널 앞 사람이 낸다(픽커가
  안 뜬다). 부수: tmux 부분 주입 실패 시 사다리 낙하 금지(이미 들어간 화살표 위에 또 보냄),
  주입 가드 15s→60s, `APP_REVIEW_NOTES` / 스티어링 불변식 문구 정정.

**여전히 미검증**: Swift 데몬의 hold 는 실기 미확인 — 실행 중인 macOS 앱 바이너리가 7월 21일
빌드라 이 코드가 없다(앱 재빌드/재기동 필요). Node 데몬은 tty 가 보이면 항상 주입을 택하므로
ask-gate 가 자연 발생하지 않는다. 실물 데크(Stream Deck/D200H) 누름도 미확인.

---
