# 2026-02-28 — Option Synchronization Fix (커서 권한 + 의미적 idle + ANSI 재위치)

### 문제
StreamDeck 디스플레이가 Claude Code 터미널의 interactive 상태(option 선택, permission)와 빈번하게 비동기화됨. 5가지 근본 원인:
1. 터미널 키보드 방향키가 ink TUI 커서를 움직이지만, 파서가 `❯`가 청크에 포함된 경우만 감지 — ink의 ANSI-only 커서 재위치 누락
2. `chunk.replace(/\s/g, '').length < 2` 임계값이 "❯ No" 같은 짧은 옵션 커서 이동을 genuine idle로 오분류
3. StreamDeck 다이얼의 optimistic 커서 업데이트를 PTY의 지연된 확인이 덮어쓰는 레이스 컨디션
4. 고정 50ms `select_option` 딜레이가 다수 화살표 이동에 불충분
5. cursorIndex 브로드캐스트가 `navigable` 플래그에만 의존 — 상태 기반이어야 함

### 해결
- **A1 (output-parser.ts)**: `lastNavigableEmit` 상태에서 ❯ 없는 소규모 청크(0 < nonWs < 100)에 디바운스 버퍼 재파싱 추가
- **A2 (output-parser.ts)**: 의미적 idle 검사 — `nonWsContent === '❯' || nonWsContent === '>'`만 idle로 분류
- **A3 (state-machine.ts)**: 커서 권한 시스템 — `updateCursorIndex(idx, 'optimistic' | 'pty')`. Optimistic은 즉시 적용, 200ms 이내 PTY 값은 stale로 억제. AWAITING 상태 이탈 시 권한 리셋
- **A4 (index.ts)**: `50 + |delta| × 20`ms 비례 딜레이
- **A5 (index.ts)**: `AWAITING_OPTION/PERMISSION/DIFF` 상태 기반 cursorIndex 브로드캐스트

### 교훈 / 핵심 설계 결정
- **Optimistic UI 패턴**: StreamDeck 다이얼 입력은 즉시 반영하되, PTY 확인에 200ms 유예기간 부여. 이 패턴은 네트워크 UI의 optimistic update와 동일하지만 PTY 지연이 원인
- **의미적 vs 구문적 감지**: `length < N` 같은 구문 기반 임계값은 짧은 옵션 텍스트에서 깨짐. `nonWsContent === '❯'` 같은 의미적 검사가 edge case에 강건
- **ANSI cursor-move 청크**: ink는 최소 재그림 시 escape 시퀀스만으로 커서를 이동 — `❯` 문자가 청크에 없어도 커서 위치가 변경됨. 버퍼 재파싱으로 대응
- **리뷰 시 발견**: A1 블록에서 `resetIdleTimer()` 누락 — 기존 ❯-포함 블록은 idle+option 타이머 모두 리셋하는 패턴이므로 새 블록도 동일하게 적용 필요
