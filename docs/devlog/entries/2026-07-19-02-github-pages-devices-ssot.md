# 2026-07-19 — GitHub Pages 재정비: 상태 라벨 정확성, Devices 카탈로그, 디자인 시스템 SSOT 완결

### 문제

공개 사이트 세 곳이 실제 구현 상태와 어긋나 있었다. InkDeck은 15라운드 실기검증 + WiFi OTA 배포까지 마쳤는데도 문서 곳곳(README 3곳, devices.md, CLAUDE.md, 공개 카탈로그 배지)이 "in development"로 남아 있었고, 반대로 XTeink X3/X4는 데몬에 정상 등록돼 있는데도 "Experimental"로 표시됐다. 서피스 총계도 두 군데가 서로 다른 "16"을 말하고 있었다. Devices 카탈로그는 사양만 나열해 "어떤 기기인지" 알 수 없었고, Live Preview는 sim 빌드가 CI(gcc)에서만 깨져 TTGO/InkDeck 두 장이 통째로 빠져 있었다. 디자인 시스템 뷰어는 컴포넌트 랩이 진짜 `.ad-*` 클래스 대신 손으로 다시 구현한 모조품을 그리고 있었고, 토큰 96개 중 spacing/radius/type/motion 계열은 전부 빈 색상칩으로 렌더돼 사실상 SSOT 역할을 못 하고 있었다.

### 해결

라벨 정확성: 실기·데몬 상태를 직접 확인(로컬 curl로 `/devices` 조회해 `xteink_x3`/`xteink_v4` 등록 실측)한 뒤 SSOT(`docs/hardware-compatibility.md`)부터 고치고 README/랜딩/카탈로그/ko·ja 미러 순으로 전파했다 — InkDeck "Yes"(USB serial + Wi-Fi WS), XTeink "Partial"(정상 동작하나 커뮤니티 CrossPoint 포크 배포라는 제약만 표기), 집계 22 surfaces로 통일.

Devices 카탈로그는 "나열"에서 "카드마다 실제 미리보기"로 전면 개편했다 — 신규 `scripts/render-device-previews.mjs`가 Pixoo/iDotMatrix/Timebox/StreamDeck/D200H를 정본 렌더러로 SVG 베이크하고, ESP32 보드는 펌웨어 sim 프레임, 앱은 실스크린샷을 쓴다. 섹션 순서는 Control decks→Apps→ESP32→Pixel. 모든 이미지는 `onerror`→hatch 폴백이라 파일 하나가 빠져도 페이지가 깨지지 않는다. sim 빌드 실패는 두 건이었다: ttgo 위젯의 `<cstdio>` 누락(clang은 통과, gcc만 에러), InkDeck sim shim의 `BOARD_INKDECK min/max` 매크로가 libstdc++ `<limits>`/`<cmath>` tr1 내부와 충돌 — 매크로 정의 전에 표준 헤더를 선로딩해 해결.

디자인 시스템 뷰어는 감사 결과를 바탕으로 세 가지를 고쳤다: ① 빌더가 이미 배포만 하던 `components.css`/`patterns.css`를 뷰어가 로드하도록 연결하고 Component lab을 정식 `.ad-*` 마크업 13종(티어 배지, 4-state 상태 점, hatch 플레이스홀더, 타이포 스케일 등)으로 재작성. ② 토큰 스펙시먼을 그룹별로 분기(radius=둥근 사각형, spacing=막대, type=실크기 샘플, motion=애니메이션 점, shadow=카드)해 96개 전부가 의미 있게 렌더되게 함. ③ 애셋 뷰를 5그룹 35종(브랜드 마크, `official-dot-glyphs.generated.ts`를 파싱해 실렌더한 도트매트릭스 마스크 15종, 크리처 SSOT 포인터, 아이콘 스펙, 레거시 Design System/Audit HTML을 실제 렌더 페이지로 배포한 레퍼런스 표면)로 완결했다.

부수적으로 세 페이지가 서로 다른 컨테이너 폭·히어로 스케일을 쓰던 것을 tokens.css 신규 토큰 `--t-page-title`(내부 페이지용, 마케팅 히어로와 분리)로 정렬했고, 사이드바 로케일 셀렉트를 뷰어 전용 컨트롤에서 사이트 공통 nav 패턴(localStorage 키 공유, 영어 정본+미번역 폴백)으로 통합했다.

### 핵심 설계 결정

- **상태 라벨은 라이브 상태를 1차 증거로 삼는다.** 문서나 이전 세션 메모리가 아니라 데몬 API를 직접 찔러 등록 여부를 확인한 뒤 라벨을 바꿨다 — "며칠 전 실험적이었다"는 근거가 되지 않는다.
- **미리보기는 실패해도 페이지를 깨뜨리면 안 된다.** 정본 렌더러/펌웨어 프레임/실사진 어느 소스든 `onerror`→hatch 플레이스홀더가 표준 계약이라, 새 보드를 sim에 추가하지 않아도 카탈로그가 당장 망가지지 않는다.
- **디자인 시스템 뷰어는 재구현이 아니라 실제 CSS/데이터를 그대로 소비해야 SSOT다.** 컴포넌트를 다시 그리면 반드시 드리프트한다 — 빌더가 프로덕션 CSS/생성 파일을 파싱해 뷰어에 공급하는 구조로 바꾼 뒤에야 뷰어 변경이 실제 회귀를 드러내게 됐다.
