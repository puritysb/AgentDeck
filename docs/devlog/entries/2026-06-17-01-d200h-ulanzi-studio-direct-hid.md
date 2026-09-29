# 2026-06-17 — D200H: 공식 Ulanzi Studio 플러그인(주) + direct-HID(폴백) + 공유 세션 덱 엔진

### 문제
D200H가 direct-HID(역공학 0x7C7C)에서 "이미지 안 뜸 + 버튼 오작동"으로 불만. 더 근본적으로 사용자가 "벤더 공식 SDK로 갈아탈지" 물음. 1차 진단으로 direct-HID는 평범한 버그(폰트·버튼맵)였지만, Ulanzi가 **공식 플러그인 SDK(Elgato 스타일, Studio 안에서 WS)** 를 제공함을 확인 → 그게 더 맞는 경로.

### 해결
- **direct-HID 폴백 수선**: resvg가 폰트 미공급(`loadSystemFonts:false`+fontFiles 없음)이라 `<text>` 전멸 → `bridge/assets/fonts`(IBM Plex Sans+JetBrains Mono, OFL) `fontFiles`+`defaultFontFamily`. 버튼맵을 렌더 layout 단일소스화(`buildButtonCommandMap`).
- **신규 `plugin-ulanzi/`** (공식 UlanziDeckPlugin-SDK vendor): **단일 동적 액션** + **세션 중심 2단계 UX(v4)** — 목록(키1=세션1, 고정위치, awaiting 강조) ↔ 상세(BACK+INFO+옵션/Allow·Deny(requestId면 permission_decision)/idle 빠른액션+STOP). 데몬 자동발견(Swift/Node 무관) + `client_register clientType:ulanzi-plugin`. self-contained 패키징(esbuild + resvg 네이티브·ws 동봉) + 원클릭 설치.
- **공유 레이아웃 엔진** `shared/src/d200h-layout.ts`: `buildSessionDeck`(v4) + 레거시 `computeLayout/buildButtonCommandMap`(direct-HID). direct-HID와 플러그인이 동일 엔진.
- **충돌 배타(App Store 완결성)**: `ulanzi-plugin` 등록 시 데몬이 direct-HID를 stand-down. Node(`ws-server`+`d200h-module.setExternalOwner`) + Swift(`DaemonServer` 훅 + `D200hHidModule.setExternalOwner`, 디바이스 미오픈만 — App-Store-safe, macOS BUILD SUCCEEDED).

### 핵심 설계 결정 / 교훈
- **기기 디코드엔 풀 데이터 URI 필수**: `setBaseDataIcon`에 `data:image/png;base64,…` 프리픽스 없으면 Studio 프리뷰는 렌더되나 **하드웨어는 못 풀어 옛 프레임 유지**(공식 데모도 풀 URI). 가장 오래 헤맨 버그.
- **더블파이어**: D200H는 키 1회 누름에 `keydown`+`run` 둘 다 발생 → 둘 다 핸들하면 open→back 상쇄. `run` 하나만 처리.
- **반응성 = Studio 경유 LCD의 한계 + 우리 오버헤드**: 풀-덱 reflow + 매 렌더 GIF 재인코딩이 Studio→하드웨어를 폭주(초당 7회). 처방: GIF 기본 OFF(정적 PNG, env opt-in) + 키별 페이싱 큐 + 렌더 throttle/dedup + PNG 캐시. Stream Deck(네이티브+SVG직결)보다는 느림.
- **Ulanzi `key` = `col_row`**("0_0"~"4_0", 실기기 13키=5+5+3) — 우리 그리드 스킴과 동일해 단일 동적 액션이 성립.
- **공식 SDK 유무를 repo 검색만으로 단정 말 것**(사용자 정정). 벤더 native .dylib SDK였다면 App Store 위반이었겠지만, 플러그인 SDK는 Studio 안에서 돌아 AgentDeck.app에 미번들 → 불변식 무관.
