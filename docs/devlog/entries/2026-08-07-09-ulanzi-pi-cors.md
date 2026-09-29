# 2026-08-07 — Ulanzi 심사 요청: PI 설정 튜토리얼을 "라이브 스테퍼"로, 그리고 CORS 오진 수정

### 문제

Ulanzi 심사팀(2026-08-07): setup 1.0.8 을 Windows 에 설치해 초기 테스트 중이며,
**플러그인 설정 영역에 H5 설치 튜토리얼**을 넣어 "첫 단계에서 막히지 않게" 해달라,
더 나은 제안이 있으면 말해달라. 1.0.2 의 PI 는 텍스트 3단계 + `/health` 라이브
체크뿐이었다.

조사 중 1.0.2 의 전제가 틀렸음이 드러났다. PI 주석/LISTING 은 "데몬이 ACAO 를
보내므로 패널이 `/health` 를 읽을 수 있다"고 적었지만, **ACAO 를 붙이는 건 Swift
데몬(HTTPServer 전역)뿐이고 Node CLI 데몬의 `/health` 에는 없다.** PI 는 foreign
origin 웹뷰이므로 fetch 가 CORS 로 차단 → 데몬이 멀쩡히 떠 있어도 "응답한 데몬이
없습니다" 로 표시된다. 즉 **Ulanzi 가 지금 테스트 중인 구성(Windows + npx 데몬)에서
정확히 오진**. 로컬 재현으로 확인했다(9120 살아있는 상태에서 cross-origin fetch 실패
→ no-cors 프로브만 통과).

부수 발견: `.uspi-refresh-btn` 은 32px 아이콘 버튼 클래스인데 1.0.2 가 텍스트 버튼에
달았고, 그 아이콘(`libs/assets/u_refresh.svg`)은 우리 패키지에 없다. 또 코드가 읽던
`health.sessions` 는 어느 데몬의 `/health` 에도 없는 필드라 2단계 판정이 死코드였다.

### 해결

PI 를 **라이브 스테퍼**로 재작성(1.0.3). 그림 3장이 아니라, 로컬 데몬을 프로브해
각 단계를 done/current 로 표시한다 — "키가 왜 OFFLINE 이냐"에 패널이 답한다.
인라인 SVG 3종(터미널/맥 앱 창/실제 5×3 D200H 페이지), macOS·Windows 탭 자동 선택,
`npx @agentdeck/setup` 원클릭 복사, en/zh_CN/ja/ko(webview locale). 자산·네트워크
의존 0, 호스트 `uspi.css` 변수와 `currentColor` 만 사용(design lint 0).

프로브는 2단 사다리다. **읽기 단**: 새 `GET /setup-status` (Node+Swift, 시크릿 없는
`{status, mode, port, state, isSwift}`) — 이것만 ACAO 를 붙인다. `/health` 에는
절대 붙일 수 없다: `pairingToken` 을 나르고, 브라우저 요청은 사용자 기기에서 나가
`isLocalConnection` 을 통과하므로 ACAO 를 붙이는 순간 **아무 웹페이지나 LAN
크리덴셜을 읽어간다.** 구 데몬용으로 `/health` 도 병렬 시도. **불투명 단**: 모두
실패하면 `mode:'no-cors'` — 응답 여부만으로 1단계는 증명되고 2단계는 "확인 불가"라고
그대로 말한다(추측하지 않는다). 세션 유무는 `state !== 'disconnected'` 로 판정
(어느 `/health` 에도 세션 카운트는 없다).

게이트: `property-inspector.test.ts` — 매니페스트가 가리키는 파일 존재, 모든
`data-i18n`/`t()` 키 해석, 로케일 키 정렬, `pairingToken` 미접근, 원격 서브리소스 0.
변이 테스트로 계측 자체를 검증(키 오타·로케일 키 변경 모두 red).

### 사후 감사 — 문구 3건이 코드와 어긋나 있었다

렌더가 깨지지 않는지만 확인하고 넘어갔다가, 문장을 코드에 대조해 3건을 고쳤다.

1. **"키 하나에 끌어다 놓으면 페이지 전체가 배치된다" — 거짓.** `positions()` 는
   사용자가 액션을 **실제로 올려둔 키 목록**이고 `buildSessionDeck` 은 그 범위에만
   레이아웃을 펼친다(`slots.length` 로 usage 예약 수까지 조절). 키 하나면 타일도
   하나다. 이 문장대로 따른 심사자는 타일 1개를 보고 "고장"이라 결론냈을 것이다 —
   **이번 리뷰를 시작시킨 바로 그 증상**(6개 키가 Studio 자리표시자로 남음).
2. **macOS 탭이 App Store 앱을 무조건적 1순위로 제시.** 그 앱은 **macOS 26+**
   (`project.yml deploymentTarget`) 이고 본토 중국 스토어프론트에 없다 — 즉 이 패널을
   가장 먼저 읽을 Ulanzi 팀에게 열리지 않는 경로다. 두 조건을 명시하고 npx 를 대등한
   경로로 표기.
3. **"ChatGPT 앱 Codex 세션이 자동 감지된다"** — `~/.codex/config.toml` 훅이 등록돼야
   성립한다. 터미널 설치는 자동 등록하지만 샌드박스 App Store 앱은 동의 UI
   (`CodexConfigInstaller`) 로만 가능하다. 즉 macOS 탭이 권한 경로에서 "자동"이 아니다.

부수로 OFFLINE 서술도 정밀화했다: 실제로는 **배치된 키 중 가운데 하나만 OFFLINE**,
나머지는 dim (`buildSessionDeck` 의 hero 계산). 심사자가 본 화면이 정확히 이것이다.

### 2차 재작성 — "요청한 포맷"은 SDK 가 이미 정의해 두고 있었다

문구를 고친 뒤에도 남은 질문: 이게 저쪽이 말한 "H5 튜토리얼" 포맷이 맞나. 공식
SDK(`UlanziTechnology/UlanziDeckPlugin-SDK`)와 레퍼런스 플러그인(analogclock)을
읽어 확인한 결과 **아니었다**. 하우스 포맷은 세 가지다:

1. **PI 는 `libs/js/*` 5개를 로드하고 `$UD.connect()` 를 호출한다.** connect 가
   Studio 로부터 `port/actionid/key/language/uuid` 를 쿼리스트링으로 받고, 소켓이
   열리면 `localizeUI()` 가 돈다. 우리 PI 는 SDK 를 아예 안 쓰고 있었다.
2. **로컬라이제이션은 `[data-localize]` + `<language>.json` 의 `Localization` 맵.**
   `data-localize="key"` 형태의 키 지정도 지원한다(`e.dataset.localize` 우선).
   즉 내가 만든 임베디드 JSON i18n 테이블은 SDK 가 이미 가진 기능의 사설 재구현이었고,
   **언어 출처도 틀렸다** — navigator locale 이 아니라 Studio 의 UI 언어가 기준이다.
3. **"H5 페이지"의 SDK 상 실체는 `$UD.openView(localHtml, w, h)`** — 로컬 HTML 을
   별도 팝업 창으로 띄우는 API. 즉 저쪽 표현은 은유가 아니라 SDK 기능 이름이었다.

그래서 재작성했다: 벤더링한 SDK libs + `$UD.connect()`, 모든 문자열을
`data-localize` 키로 전환하고 `en/zh_CN/zh_HK/ja_JP/ko_KR.json` 의 `Localization`
으로 이관(액션 팔레트 이름·툴팁도 같은 파일이 담당하므로 한 파일로 두 표면 커버),
그리고 요청받은 H5 페이지 `property-inspector/tutorial.html` 을 추가해 패널의
버튼이 `openView(..., 900, 780)` 로 연다. 패널/페이지 공통 스킨·로직은
`tutorial.css` + `setup-common.js` 하나로 묶어 두 표면이 갈라지지 못하게 했다.

**단, 레퍼런스 샘플의 한 가지는 일부러 따르지 않았다**: 샘플은 `.uspi-wrapper` 를
`hidden` 으로 두고 `onConnected` 에서 해제한다 — connect 가 실패하면 **빈 패널**이다.
그건 이번 리뷰를 연 증상 그 자체라, 영문 원문을 마크업에 두고 항상 렌더한 뒤
번역만 덧씌우는 방향으로 뒤집었다(테스트로 고정: 모든 `[data-localize]` 요소는
비어 있으면 안 된다).

검증 중 실기기 없이도 잡힌 버그 하나: SDK libs 는 파일 끝에서 `const $UD = ...`,
`const Utils = ...` 로 선언한다. **classic script 의 top-level `const` 는 전역
렉시컬 바인딩이라 `window` 의 프로퍼티가 아니다** — 내가 쓴 `window.$UD &&` 가드는
항상 false 였고, "설치 튜토리얼" 버튼이 조용히 숨겨졌다. `typeof $UD !== 'undefined'`
로 교체. 프리뷰가 **실행 중이던 실제 Ulanzi Studio(3906)** 에 붙어 `ko_KR.json` 으로
번역된 것이 이 경로 전체의 실동작 증거다(스텁 아님).

### 실기기 검증 (2026-08-08, D200H + Ulanzi Studio)

기기가 연결된 실제 Studio 에서 전 경로 확인:

- **PI 가 설정 영역에 렌더된다** — 1.0.2 이후 아무도 확인한 적 없던 항목.
- **Studio 언어로 현지화된다** — `$UD.connect()` 가 넘겨받은 `ko-KR` 로 `ko_KR.json`
  의 `Localization` 이 적용됨(액션 팔레트 이름/툴팁도 같은 파일).
- **라이브 프로브가 상세까지 읽는다**: "데몬이 실행 중입니다 (포트 9120)" +
  "세션이 실행 중입니다" → 1·2단계 체크. 주목할 점은 이 데몬이 `/setup-status`
  없는 옛 빌드라는 것 — 즉 **Studio 안에서는 `/health` 가 cross-origin 으로도 읽힌다**
  (webview origin 이 CORS 로 막히지 않는다). `/setup-status` 는 그래도 유지한다:
  브라우저 컨텍스트와 더 엄격한 호스트에서 필요하고, `/health` 를 열지 않고도
  같은 답을 주는 유일한 방법이며, 무엇보다 `pairingToken` 을 노출하지 않는다.
- **`$UD.openView('./property-inspector/tutorial.html', 900, 780)` 로 H5 팝업이 열린다**
  (출하 경로 표기 그대로 단독 검증). 페이지도 Studio 언어로 뜨고, **완료 버튼의
  `window.close()` 로 닫힌다** — SDK 계약대로.
- **팝업이 Studio 창 뒤에서 열릴 때가 있다**(앞/뒤 둘 다 관측). 눌러도 아무 일 없는
  것처럼 보이는데, 그게 이번 리뷰를 연 증상이라 **정적 안내 한 줄**을 버튼 밑에 뒀다.
  처음엔 클릭 후 표시되는 동적 힌트로 만들었다가 정적으로 바꿨다 — 팝업이 포커스를
  가져가면 PI 가 재구성되어 클릭이 세운 상태가 날아간다.

이 과정에서 **측정으로 뒤집은 오판 두 건**을 남긴다. ① "openView 가 동작하지 않는다"
— 실제로는 열려 있었고 Studio 창 뒤에 가려져 있었다. ② "Studio 가 PI 를 캐시해서 내
수정이 반영되지 않는다" — 실제로는 **PI 패널이 짧은 스크롤 뷰포트**라 버튼 아래 줄이
접혀 있었을 뿐이다. 둘 다 "화면에 없다 = 동작하지 않는다"로 건너뛴 추론이었고,
창을 옮기고 패널을 스크롤하자 즉시 반증됐다. GUI 검증에서는 **보이지 않는 것을
없는 것으로 읽기 전에 뷰포트와 z-order 를 먼저 의심해야 한다.**

### 교훈

**"요청한 포맷"은 상대의 문장이 아니라 상대의 SDK 에서 확인해야 한다.** "H5 튜토리얼을
설정 영역에" 를 나는 은유로 읽고 자체 구현을 얹었지만, 그 문장의 거의 모든 단어가
SDK 의 실제 기능명(`openView`, property-inspector, `Localization`)이었다. 상대가
프레임워크를 제공하는 관계에서 요구사항이 오면 **먼저 그 프레임워크의 레퍼런스
구현을 읽는다** — 안 그러면 이미 있는 기능을 사설로 재구현하고, 그 재구현은 리뷰어
눈에 "규약을 안 지킨 플러그인"으로 보인다.

**튜토리얼 문구는 코드 주장이다 — 렌더 검증은 문구 검증이 아니다.** 4개 언어로 예쁘게
뜨는 것과 그 문장이 참인 것은 완전히 다른 축인데, 스크린샷이 예뻐서 검증했다고 착각하기
쉽다. 특히 **"플러그인을 어떻게 배치하는가" 같은 문장은 레이아웃 엔진의 입력 계약을
읽고 써야 한다.** 그리고 **설치 경로를 안내할 때는 그 경로의 가용 조건(OS 최소 버전,
스토어프론트, 사전 동의 단계)까지가 문장의 일부다** — 조건을 빼먹은 1순위 안내는 그
조건에 걸린 사용자에게는 첫 단계에서 막히라는 뜻이고, 이번엔 그 대상이 요청자 본인들이었다.

**"이 필드를 읽을 수 있다"는 주석은 관측이 아니라 가정이었다.** 1.0.2 는 ACAO 존재를
단정하는 주석을 달고 그 위에 UX 를 얹었고, 두 데몬 중 하나만 사실이었다. 크로스
오리진·크로스 구현 전제는 **양쪽 구현에서 실제로 한 번 찍어보고** 적어야 한다.
그리고 **CORS 를 열어 고치고 싶을 때는 그 응답에 무엇이 실려 있는지부터 본다** —
`/health` 는 편의상 열기 딱 좋은 라우트이자 절대 열면 안 되는 라우트였다. 답은
라우트를 여는 게 아니라 **시크릿 없는 라우트를 새로 만드는 것**.

검증: vitest 170 파일 2722 테스트 green, `tsc -p bridge` clean, `design/lint.sh`
에서 inspector.html 위반 0, `pnpm package` 로 1.0.3 zip 빌드(PI 바이트 동일 포함),
Chrome 에서 4개 상태 × 4개 로케일 렌더 스크린샷 확인.

---

---
