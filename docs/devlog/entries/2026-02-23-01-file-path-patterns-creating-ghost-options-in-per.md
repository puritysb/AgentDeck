# 2026-02-23 — File path patterns creating ghost options in permission parser

### 문제
`Read(/tmp/.../D_01.png)` 같은 파일 경로가 permission prompt에 포함될 때, normalization regex가 `_01.png)`를 `\n01.png)`로 분리하여 ghost option(index 0, label `png)`)을 생성. 이로 인해 실제 "Yes" 옵션이 덮어쓰여 `1. png)`, `2. No`만 표시되는 현상.

### 해결
1. **Normalization regex 강화**: `(?!\d)` → `(?![a-z\d])` — 소문자 파일 확장자 뒤에서 split 방지
2. **Extraction-level defense**: `^[a-z]{1,10}\)$` 패턴의 label(파일 확장자 아티팩트) skip

### 교훈
- 파서 regex는 "숫자+점" 패턴이 option 번호인지 파일 경로의 일부인지 구분해야 함
- 다층 방어(normalization + extraction)가 안전 — 한 계층이 놓치면 다른 계층이 잡음
