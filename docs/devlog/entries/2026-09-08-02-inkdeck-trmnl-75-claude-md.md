# 2026-09-08 — InkDeck → `trmnl_75` 리네임, 사용량 스트립 자리 고정, CLAUDE.md 낡은 사실 정리

### 문제

7.5" e-ink 보드만 이름 규칙에서 벗어나 있었다. 나머지 보드는 전부 벤더 제품명
(`Ulanzi TC001`, `Waveshare C6-LCD-1.47`, `RockBase NM-EPD-420`)이거나 패널 서술
(`IPS 10.1"`, `Round AMOLED`)인데, 이 보드만 **InkDeck** 이라는 우리가 지어낸
이름이었다. 사용자가 그 이름으로 살 수 있는 물건이 없다 — 실물은 **Seeed TRMNL
7.5" OG DIY Kit** 이다.

### 해결

`inkdeck` → `trmnl_75`, 표시 이름 `Seeed TRMNL 7.5"`. 90개 파일 419군데(코드·문서·
Pages·디자인 시스템·펌웨어 매크로·Swift 프리뷰·에셋 파일명)를 한 번에 옮겼다.
식별자 형태별로 규칙을 나눴다: `BOARD_INKDECK`→`BOARD_TRMNL_75`,
`AGENTDECK_INKDECK_UI`→`AGENTDECK_TRMNL_75_UI`, `InkDeckPreview`→`Trmnl75Preview`,
`board_inkdeck.h`/`docs/media/inkdeck.jpg` 도 함께 rename.

**이미 플래시된 보드가 이 rename 의 유일한 사각지대다.** 현장 보드는 자신이
빌드된 이름(`inkdeck`)을 OTA 를 받기 전까지 계속 보고하는데, 그 OTA 를 보내려면
데몬이 그 보드를 찾아야 한다 — 즉 canonical id 만 옮기면 **이름을 바꿔 줄 바로 그
경로가 그 보드를 못 찾는다.** 그래서 `LEGACY_BOARD_IDS` / `canonicalBoardId()` 를
SSOT 에 두고 (1) `findWifiOtaTarget` 의 board 비교, (2) `resolveStagedFwBoard`,
(3) glance frame geometry 조회를 전부 canonical 비교로 바꿨다. Swift 쪽 Surface
등록 allow-list 는 생성 미러 블록 **바깥에** `legacySurfaceFirmwareBoards` 로
따로 뒀다 — 보드 카탈로그가 아니라 "현장에 남은 전선 문자열"이므로 미러 게이트가
검사하는 집합을 오염시키면 안 된다. CLI 별칭(`agentdeck esp32-ota inkdeck`)도
유지되므로 사용자의 셸 히스토리가 계속 동작한다.

### 검증

- vitest 265 파일 4,156 통과 (legacy id 회귀 테스트 1개 추가), typecheck 통과
- `generate-esp32-board-matrix --check` 12보드 일치 (별칭 표까지 재생성)
- SYNC-HASH 핀 2개 재계산 — pinned origin(`eink_display.cpp`,
  `eink_dashboard_layout.h`) 변경분은 매크로/주석 rename 뿐임을 diff 로 확인 후 bump
- `pio run -e trmnl_75` 실제 펌웨어 빌드 SUCCESS, sim `render.sh trmnl_75` 프레임
  800×480 정상 렌더
- docs:check / design-system:check / tokens-sync / surface-mirrors / hardware
  spec cards 전부 통과. HTML `alt` 속성 안에 들어간 인치 기호는 `&quot;` 로 이스케이프
  (일괄 치환이 속성을 깨뜨린 자리 3곳, Swift 문자열 리터럴 1곳을 손으로 고침)

CHANGELOG 은 릴리스 컷 시점에 쓴다(`verify-release-version` 이 강제). 과거 devlog/
CHANGELOG 항목의 "InkDeck" 표기는 그대로 둔다 — 그때 그 이름으로 나간 기록이다.

### 사용량 스트립: 자리(seat)와 순위(rank)를 분리하다

**증상.** Stream Deck 키패드에서 사용량 게이지 순서가 어떤 때는 `5H 7D FABLE CODEX`,
어떤 때는 `5H 7D CODEX FABLE` 로 나온다.

**원인은 의도된 코드였다.** `scopedLimitClaimsUsageKey` 의 문서가 명시하고 있었다 —
"ACTIVE 캡은 Codex보다 앞, INACTIVE 캡은 뒤". 근거(#99)도 진짜다: 집계 5H/7D 가
낮은데 per-model 주간 캡만 바인딩일 수 있으니, 자리가 모자랄 때 그 캡이 먼저다.

문제는 **한 리스트로 두 질문에 답한 것**이다. "좁은 스트립에서 무엇이 살아남는가"
(순위)와 "살아남은 것들이 어디에 앉는가"(자리)는 다른 질문인데, 순위 리스트를 그대로
그리니 캡이 바인딩 상태가 바뀔 때마다 **좌석을 옮겨 다녔다**. 화면에는 왜 옮겼는지
아무 표시도 없다. 사용자가 기억하는 건 위치다.

**수정.** `USAGE_STRIP_ORDER = claude → scoped → codex → credits` 를
`shared/src/format-utils.ts` 에 SSOT 로 두고:
- D200H/Ulanzi(`buildUsageTiles`)는 캡을 항상 Claude 쪽에, Codex 앞에 놓는다.
- Stream Deck 키패드는 `usageGauges()`(순위, 페이징용)와 `usageGaugesForDisplay()`
  (자리)를 분리했다. 5개 초과로 페이징할 때 informational 캡이 살아있는 Codex 창을
  2페이지로 밀어내지 않는다는 #99 의 의도는 순위 쪽에 그대로 남아 있다.
- `active` 가 여전히 결정하는 것: 램프(critical vs 정보성 시안)와 페이징 순위. 자리는 아니다.

### D200H 3키 스트립: 주간 판독 둘을 한 키에

같은 스트립의 압축 규칙도 바꿨다. 기존에는 5개 판독(Claude 5H/7D, 캡, Codex 5H/7D)이
3키에 들어갈 때 **Claude 5H+7D 를 한 키로 묶고 캡이 키 하나를 통째로** 썼다.

바꾼 규칙: **세션 중 실제로 움직이는 건 5H** 이고 7D 와 per-model 주간 캡은 둘 다
주간이라 같이 읽는다. 그래서 `5H` | `7D + FABLE` | `CODEX 5H+7D` 로 나눈다.
키 수는 그대로 3, 버려지는 판독도 여전히 0.

    5H  42%   |  7D 17%  / FABLE 98%  |  CX 5H 30% / 7D 10%

**검증.** TS 엔진과 Swift 프리뷰 미러(`D200HLayoutModel`)를 각각 실행해 6개 시나리오
문자열을 대조했다. 5개는 완전히 동일했고, 6번째(5h 없이 7d만)가 아래의 **유령 타일**을
드러냈다.

### 없는 창을 0%로 채우면 "0% 썼다"와 구별되지 않는다

Claude 5h/7d 두 창은 **독립적으로 보고된다** — `parseUtilization` 이 여러 응답 모양을
관대하게 파싱하는 이유가 그것이고, 한쪽이 없으면 `usage_update` 는 그 키를 아예 빼고
나간다(`fiveHourPercent?: number`). 프로듀서는 처음부터 옳았다.

무너진 곳은 소비자 **두 군데**였고 둘 다 `?? 0` 이었다: `parseState`
(`shared/src/d200h-layout.ts`)와 `plugin-ulanzi/src/state-store.ts`. 데크를 실제로
그리는 건 플러그인 번들이므로 **`parseState` 만 고쳤으면 기기에서는 그대로였다.**
`usageKnown` 은 "쿼터 소스가 있느냐"는 **계정 단위** 플래그라 창 단위 질문에 답할 수
없다 — 그래서 `if (known && state.fiveHourPercent != null)` 가 항상 참이었고, 주간만
있는 구독이 `5H 0%` 게이지에 키 하나를 통째로 썼다. 같은 표면의 Swift 미러는 optional
이라 생략했으니, **양 데몬이 같은 입력에 다른 그림을 그리고 있었다.**

수정: 두 소비자 모두 없는 값을 `undefined` 로 통과시키고, `renderUsageButton` 은
percent 가 없으면 caller 가 뭐라 했든 unknown("—")으로 그린다. Stream Deck 키패드도
같은 결함의 약한 버전이 있었다 — 창 하나만 알아도 **쌍으로** push 해서 없는 창에
"—" 타일로 키를 예약했다(자기 주석은 이미 hide-if-absent 라고 적고 있었다). 창별로
분리했다.

**측정한 0% 는 판독이지 부재가 아니다** — 세 표면 테스트 모두 실제 0% 는 계속 그리는지
같이 고정한다. 테스트 함정 하나: SVG 원문에 `not.toContain('5H')` 를 걸면 안 된다.
Claude 마크의 path 데이터에 `...5H24...` 같은 `H`(horizontal lineto) 명령이 들어 있어서
라벨이 없는 타일에도 통과한다 — `<text>` 내용을 뽑아서 비교할 것.

렌더까지 확인(rsvg): 바인딩 캡은 빨간 임계 램프, 비바인딩 캡은 정보성 시안으로
같은 자리에 그려진다. Swift 미러는 pair 행이 캡을 실을 수 있게 되었으므로
`D200HUsagePairWindow.inactive` 를 추가했다(없으면 기기는 시안, 프리뷰는 빨강).
`shared/src/d200h-layout.ts` SYNC-HASH 핀 재계산.

### 합성 수치로는 안 보이던 것: `FABLE100%`

**설치 후 실제 쿼터로 렌더해보고서야 나온 결함.** pair 행은 라벨을 왼쪽에, 값을
오른쪽 정렬로 놓는데 두 행이 모두 창일 때는 안전했다 — `5H`/`7D` 는 두 글자다.
캡이 그 줄을 같이 쓰게 되면서 여섯 글자짜리 이름이 세 자리 퍼센트와 붙어
`FABLE100%` 로 그려졌다(실측: 5h 3%, 7d 88%, Fable **100%** active).

합성 테스트 값(98%)으로는 폭이 한 픽셀 모자랐을 뿐이라 안 드러났다 — **레이아웃
변경은 그 표면의 실제 데이터로 한 번 그려봐야 한다.** 이름은 사용자가 알아봐야
하는 부분이라 자르지 않고 라벨 폰트를 줄였다(`length >= 5 → 14px`). Swift 미러는
HStack+Spacer라 겹치진 않지만 답답하게 읽히므로 같은 규칙을 넣었다.

### 배포: 커밋은 화면을 바꾸지 않는다

이 라운드의 데크 수정 두 건은 **플러그인 번들이 그린다.** 커밋 시점에 실제로
돌고 있던 것은 전부 옛 바이트였다: 데몬 pid 1078(07:13 기동, build `64c27f0274af`),
SD 마켓플레이스 DRM 번들(9/4), Ulanzi 패키지본(9/2), 앱 dev 빌드(9/7).

- 데몬: 재시작 → `health.build == distBuildId`. 보드 21개 재접속.
- **Stream Deck: DRM 번들에는 로컬 빌드를 넣을 수 없다**(해시 불일치 → 조용한
  실행 차단). 마켓플레이스본을 통째로 백업하고 `streamdeck link` 로 전환.
  이후 이 기기는 마켓플레이스 업데이트를 받지 않는다 — 릴리스 검증 때는 링크를
  풀고 재설치할 것.
- Ulanzi: `package-ulanzi-plugin.sh` 재패키징 → 설치 → Studio 재시작.
- 앱: Release 는 `Mac App Distribution` 인증서가 없어 실패(로컬 제약), 기존
  설치본과 같은 Debug/dev 서명으로 빌드해 교체.

**live 확인 하나 더**: 192.168.68.75 의 e-ink 보드는 펌웨어 v1.2.0 이라 자기를
여전히 `inkdeck` 으로 보고하고 새 데몬이 그대로 받는다 — legacy id 번역 테이블이
없었으면 이름을 바꿔줄 OTA 가 이 보드를 못 찾았을 자리다.

**후속(2026-09-09 해결)**: `agentdeck daemon restart` 가 성공을 실패로 보고한다. 2회 모두
`restart FAILED — no daemon with PID <n> is answering` 을 찍었지만 실제로는 다른 pid 가
포트를 잡고 정상 기동했다. 원인은 launchd 였다 — 아래 2026-09-09 항목.

### CLAUDE.md 정리

같은 턴에 CLAUDE.md 의 **검증 가능한 낡은 사실**만 골라 고쳤다. 추측으로 지우지
않고 하나씩 대조했다:

- `hooks/` 항목이 아직 `~/.claude/settings.local.json` 를 설치 대상이라 말하고
  있었다 — 같은 파일의 Key Conventions 는 그 파일이 user scope 에서 **죽은 파일**
  이라고 못박고 있어 자기모순이었다 (`hooks/src/install.ts` 는 `settings.json` 을 씀)
- Stream Deck 플러그인 "Five actions" → 실제 manifest 는 **6개**(`limit-key` 누락)
- design-system "27 documents" → 실측 31. 숫자를 다시 박는 대신
  `design-system:check` 가 출력하는 값을 읽으라고 바꿨다(토큰 미러 개수와 같은 방식)
- "`pnpm-workspace.yaml` enforces the engine contract" → 범위는 `package.json`
  `engines`, `pnpm-workspace.yaml` 은 `engineStrict` 로 치명적으로 만들 뿐
- coverage 문장의 존재하지 않는 CI 스텝 이름 → 실제 명령
- 규칙이 붙지 않은 순수 연대기(삭제 날짜, README 이관 날짜 등) 제거
- 13KB 짜리 한 줄이던 `bridge/` 항목을 규칙별 하위 불릿으로 쪼갰다. 내용은
  docs/apme.md 와 DEVELOPMENT_LOG 에 이미 있는 서사 위주로 줄이고 불변식은 남겼다
