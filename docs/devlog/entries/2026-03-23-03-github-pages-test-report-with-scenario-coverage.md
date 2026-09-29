# 2026-03-23 — GitHub Pages test report with scenario coverage matrix

### 문제
테스트 프레임워크 정비(Vitest 850+, Android 82, Robot 8)가 완료되었으나 결과를 팀에서 쉽게 열람할 방법이 없었고, 주요 사용자 시나리오별 테스트 커버리지가 어느 정도인지 한눈에 파악 불가.

### 해결
- **GitHub Pages 자동 배포**: `.github/workflows/test-report.yml` — push to master 시 Vitest + Android JUnit + Robot Framework(no-hw) 실행 → `generate-html-report.py`로 HTML 대시보드 생성 → Pages artifact 배포
- **시나리오 매트릭스**: `scenario-matrix.json`에 10개 핵심 사용자 시나리오(Session Lifecycle, Permission Flow, Multi-agent Monitoring 등) 정의, vitest JSON 결과와 크로스 레퍼런스하여 unit/integration/platform/e2e 커버리지 상태를 색상 코딩 표시
- **테스트 카테고리 태그**: 파일명 패턴으로 `[unit]`/`[integration]`/`[snapshot]` 자동 분류 + 필터 버튼
- **히스토리 스파크라인**: `history.json` 50건 유지, 배포 간 `curl`로 전달, 2회차부터 SVG 스파크라인 표시
- **랜딩 페이지**: `scripts/pages-index.html` — 루트에 프로덕트 소개, `/reports/`에 테스트 리포트
- **Robot Framework CI**: `pip install robotframework platformio` → `no-hw` 태그 빌드 테스트만 실행 (하드웨어 불필요)

### 핵심 설계 결정
- `ci.yml`과 `test-report.yml` 분리 — CI는 빠른 피드백(test+typecheck만), Pages 배포는 별도 워크플로우에서 전체 프레임워크 실행
- `gh-pages` 브랜치 대신 Actions artifact 기반 배포 — 브랜치 오염 방지
- vitest `|| true` — 스냅샷 테스트 환경 차이(CI vs 로컬)로 실패해도 배포 차단하지 않음, 결과는 리포트에 반영
- Robot Framework `--include no-hw --exclude hw` — CI에서 실행 가능한 빌드 테스트만 선별

---
