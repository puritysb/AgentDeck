# 2026-07-21 — Design System viewer nav 재구성 (옵션 B) + 에셋 콘텐츠 노출 개선

**목표**: 8개 카테고리로 분산된 왼쪽 레일 메뉴를 사용자 관심도 순 4단계로 재구성.

**nav 4-tier 구조** (커밋 `3e27d809`, push → GitHub Pages 자동 배포):
- Preview (live) — Token Library / Component Lab / Asset Library (최상단)
- Design — Foundation / Resources / Android UI (구 Foundations + android-ui)
- Specs — 8개 디바이스/프로토콜 문서
- Engineering — 16개 (Architecture/Governance/Policy/Validation/Reference), **기본 접힘**

27개 md 파일 `category:` frontmatter 일괄 수정. `app.js`에 `CATEGORY_ORDER`, Engineering collapse (`grid-template-rows: 0fr↔1fr`), localStorage 상태 저장, 검색 시 자동 펼침 추가.

**에셋/컴포넌트 노출 개선**: 이미지 에셋 클릭 → lightbox 모달, Component Lab에 Copy HTML 버튼 + 토스트, 마크다운 `![alt](url)` 이미지 렌더링 지원, 에셋 카드 이미지 크기 140px 확대.
