# 2026-07-28 — Elgato Marketplace 승인: "심사 중"으로 남아 있던 표면 정리

Stream Deck 플러그인 1.0.2가 승인되어
`https://marketplace.elgato.com/product/agentdeck-dce3806b-176e-40f2-be7d-e029bec0f464`
로 공개됐다(HTTP 200 확인, 페이지 내 버전 1.0.2). 2026-07-25 1차 리젝 3건
(in-app 아이콘 흰색·제품 미디어·데모 영상)에 대응한 재제출본이 통과한 것이다.

레포에는 승인 이전 상태가 여러 곳에 굳어 있었다. README 서피스 표는 제네릭
`marketplace.elgato.com` + *(in review)*, 릴리스 표는 "Maker upload pending",
`docs/roadmap.md`는 "submission pending" 미체크 박스, `marketplace/elgato/LISTING.md`
는 "still in Elgato's initial review (not yet published)", `docs/install.md`는
Stream Deck 설치 경로로 **체크아웃 심볼릭 링크만** 안내하고 있었다. 승인
사실 자체보다 이 "설치 경로가 개발자용밖에 없다"가 실사용자에게 더 큰 문제였다.

### 반영한 표면

- **README** — 배지 행에 Elgato Marketplace 배지 추가(Mac App Store 옆), 서피스
  표 행을 실제 제품 URL + "One click"으로, 릴리스 표를 "1.0.2 live (approved
  2026-07-28)"로 교체
- **Pages 홈**(`scripts/pages-index.html`) — hero CTA에 "Get the Stream Deck
  plugin" 버튼 추가 + `cta.streamdeck` ko/ja 사전 항목. 사이트 3개 언어가 같은
  키를 공유하므로 en 문자열만 넣으면 ko/ja에서 영어가 새어나온다
- **★og/twitter 메타 태그 신규 추가**(같은 파일) — 랜딩에 소셜 카드 태그가
  **하나도 없었다**. 마켓플레이스 공지를 어디에 뿌리든 링크 프리뷰가 맨링크로
  나가는 상태였으므로 공개 시점에 같이 막았다. `og:image`는 **절대 URL 필수** —
  크롤러는 페이지 컨텍스트 없이 이미지를 가져가므로 상대경로면 조용히 빈
  프리뷰가 된다. 이미지는 Pages 조립 단계가 `docs/media/*.jpg`를 `_site/media/`로
  복사하는 `setup-full.jpg`를 가리킨다
- **Devices 페이지** — Stream Deck 카드 sub 카피(en/ko/ja)에 마켓플레이스 공개
  사실을, specs에 `Install / Elgato Marketplace` 행을 추가. 카드는 링크를 품지
  않는 기존 패턴(macOS 카드도 App Store를 카피로만 언급)을 그대로 따랐다
- **docs/install.md** — §2를 "Link"에서 "Install"로 바꾸고 **마켓플레이스 설치를
  1순위**, 체크아웃 링크를 개발용으로 강등. 같은 UUID 두 벌 충돌 경고 추가
- **docs/streamdeck-layout.md · docs/roadmap.md · CHANGELOG.md · RELEASING.md ·
  marketplace/elgato/LISTING.md** — 심사 중 문구 제거, 공개 사실과 URL 기록

### ★규칙: 게시 시점부터 monotonic-version 규칙이 켜진다

리젝 리비전을 **같은 버전(1.0.2.0)으로 재제출**할 수 있었던 건 그 빌드가
pre-publication 상태였기 때문이다. 이제 published 빌드가 존재하므로 다음
리비전은 반드시 더 높은 버전이어야 한다. `scripts/verify-version-sync.mjs`가
streamdeck 버전을 `<VERSION>.0`으로 하드핀하고 있어서, 4번째 컴포넌트만 올리는
리빌드는 게이트와 충돌한다 — 다음 제출은 `VERSION` 패치 범프를 동반해야 한다.
RELEASING.md와 LISTING.md 양쪽에 적었다.

게이트: `pnpm docs:check`(87 files), `sync-pages-nav --check`,
`sync-hardware-spec-cards --check`, `pnpm design-system:check`(27 docs) 모두 통과.

---
