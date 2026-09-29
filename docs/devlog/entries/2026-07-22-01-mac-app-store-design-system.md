# 2026-07-22 — Mac App Store 공개 상태 반영 + Design System 탐색 라벨 간결화

`AgentDeck Dashboard` macOS 1.0.0이 2026-07-21 공개된 사실과 정식 상품 URL(`https://apps.apple.com/app/id6784822497`)을 README, Pages 홈 CTA, 설치/Apple 앱/출시 정책/로드맵/디바이스/심사 문서에 반영했다. 저장소의 통합 버전은 이미 1.0.1이므로 “현재 소스 버전”과 “현재 공개된 스토어 버전”을 분리해 기록했고, iPhone/iPad companion은 계속 심사 중으로 표시했다.

Design System 레일은 문서의 정식 제목은 그대로 유지하면서 27개 문서의 en/ko/ja 짧은 탐색 라벨을 `catalog.json` 정본으로 추가했다. 생성기는 라벨의 전체 문서 커버리지, 알 수 없는 ID, 공백, locale 누락, 24자 상한을 검증한다. 섹션 표시는 `Library / Design / Platforms / Project`로 간결화하고 기본 진입점을 Tokens로 변경했으며, Project의 새 저장 키로 기존 과도한 펼침 상태를 초기화했다. 데스크톱 레일 폭·간격을 줄이고 단일 행 ellipsis + 정식 제목 tooltip을 적용했다.

접힌 Project 문서가 화면에서는 보이지 않아도 접근성 트리와 키보드 탐색에 남던 추가 결함도 발견했다. 닫힌 group body에 `visibility: hidden`을 적용하고 모바일의 평탄화된 칩 행에서는 다시 visible로 복원했다. `design-system:check/build`, 버전 동기화, GNB 동기화, 토큰 동기화와 14개 gap self-test를 통과했고, 390px 및 데스크톱 실브라우저에서 기본 Tokens, 짧은 다국어 라벨, Project 접힘/접근성, 단일 행 모바일 메뉴, overlay 비노출을 확인했다.
