# 2026-02-22 — PTY ANSI Chunk Splitting & False Option Detection

### 문제
1. **ANSI 시퀀스 분할**: PTY 청크가 `\x1b[38;2;177;185;249m` 같은 SGR 코드 중간에서 잘릴 때, `strip-ansi`가 불완전 시퀀스를 매치 못해 잔여 텍스트(`;2;177;185;249mYes`)가 옵션 라벨에 오염.
2. **응답 텍스트 오감지**: Claude 응답 본문의 번호 목록("1. First approach\n2. Second...")이 `OPTION_NUMBERED` 정규식에 매치되어 interactive option/diff prompt로 오분류.
3. **CJK 서제스트 차단**: `scheduleSuggestion`의 `\w{2,}` 필터가 ASCII만 매치 → 한글/일본어 ghost text 전부 무시.

### 해결
1. **`pendingAnsi` 버퍼링**: `feed()`에서 청크 끝 20자 내 불완전 ESC 시퀀스(CSI/OSC/bare ESC)를 `pendingAnsi`에 보류, 다음 청크 앞에 결합. `cleanOptionLabel`에도 `stripAnsi()` 이중 방어.
2. **대형 청크 가드**: `detectPatterns()`에서 `OPTION_NUMBERED`/`OPTION_BULLET` 매치 시 `chunkNonWs < 200` 조건 추가. 실제 TUI 옵션은 소형 청크, 응답 텍스트는 대형 청크.
3. **Unicode letter 매치**: `\w{2,}` → `\w{2,} || \p{L}{2,}` (ES2018 Unicode property escape).

### 교훈
- PTY는 ANSI 시퀀스 경계를 보장하지 않음 — 모든 raw 데이터 처리에 불완전 시퀀스 고려 필요
- 정규식 기반 TUI 파싱에서 **청크 크기**는 interactive vs. informational 텍스트 구분의 강력한 휴리스틱
- JavaScript `\w`는 ASCII 전용 — CJK 텍스트 처리 시 `\p{L}` 필수

---
