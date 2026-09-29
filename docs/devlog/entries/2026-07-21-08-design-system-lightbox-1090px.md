# 2026-07-21 — Design System 뷰어를 가린 lightbox와 모바일 1090px 레일 수정

에셋 lightbox가 `hidden`으로 시작하는데도 공개 `/design-system/` 전체를 blur overlay로 가렸다. 작성자 규칙 `.lightbox { display: flex }`가 브라우저 기본 `[hidden] { display: none }`보다 우선한 것이 원인이라, 뷰어 전역 `[hidden] { display: none !important }` 계약으로 고쳤다. 닫기 버튼과 Esc도 이제 실제로 overlay를 숨긴다. `design-system:check`가 초기 lightbox의 `hidden`과 이 CSS 계약을 함께 검증해 같은 회귀를 로컬에서 막는다.

같은 기능의 반응형 점검에서 두 번째 결함도 발견했다. 720px 이하 가로 레일에서 Engineering의 grid wrapper가 16개 내부 항목의 높이(약 1,078px)를 flex line에 전달해 모든 메뉴 칩이 약 1,082px 높이로 늘어났다. 모바일 media query에서 regular/collapsible group wrapper를 모두 `display: contents`로 평탄화해 레일을 47px 단일 가로 스크롤 행으로 고정했다. 390px 실브라우저와 720/721px 경계에서 페이지 가로 overflow 없음, 초기 overlay 숨김, asset 열기/닫기를 확인했다.
