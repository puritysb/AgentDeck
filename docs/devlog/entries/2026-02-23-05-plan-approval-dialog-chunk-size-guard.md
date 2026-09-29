# 2026-02-23 — Plan Approval Dialog 미감지 (chunk size guard 오필터링)

### 문제
Plan approval dialog이 터미널에 표시되지만 Stream Deck에 반영되지 않음. `output-parser.ts`의 chunk size guard(`chunkNonWs < 200`)가 plan approval dialog을 필터링.

이 guard는 Claude 응답 텍스트의 번호 목록(e.g. "1. First approach\n2. Second approach")이 interactive option으로 오탐되는 것을 방지하기 위해 도입됨. 하지만 실제 plan approval dialog의 non-ws 문자 수가 ~264자로 200을 초과:
- 옵션 1의 긴 레이블: `"Yes, clear context (33% used) and auto-accept edits (shift+tab)"`
- 하단 footer: `"ctrl-g to edit in VS Code · ~/.claude/plans/crystalline-moseying-raccoon.md"`

결과: `OPTION_NUMBERED` regex 매치 → `chunkNonWs < 200` 조건 실패 → option detection 완전 스킵.

### 해결
`❯` 커서(navigable cursor)가 번호 옵션 앞에 있으면 chunk size와 무관하게 bypass:
```typescript
const hasNavigableCursor = /^\s*❯\s*\d{1,2}[.)]/m.test(chunk);
if (... && (hasNavigableCursor || chunkNonWs < 200)) {
```
Claude 응답 텍스트에는 `❯ 1.` 패턴이 절대 나타나지 않으므로 false positive 위험 없음.

### 교훈
- **Chunk size guard 설계**: 크기 기반 필터는 불완전한 휴리스틱. 콘텐츠가 길어질 수 있는 정상 케이스를 고려해야 함. 확정적 TUI 마커(`❯` 커서)가 있으면 크기 조건을 우회하는 것이 더 안정적
- **테스트 데이터 현실성**: 기존 테스트의 짧은 옵션 레이블이 버그를 은폐함. 실제 데이터와 유사한 테스트 데이터 사용 중요

---
