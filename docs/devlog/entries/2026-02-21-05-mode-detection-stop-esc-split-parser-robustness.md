# 2026-02-21 — Mode Detection, STOP/ESC Split, Parser Robustness

### 문제

1. **DEFAULT 모드 미감지**: Mode 버튼으로 Accept → Default 전환 시 Claude Code가 `? for shortcuts` 배너를 출력하지만, 파서가 이를 감지하지 못해 디스플레이가 ACCEPT에 머물러 PLAN ↔ ACCEPT만 순환
2. **800ms 디바운스 과도**: 빠른 버튼 입력이 드롭됨
3. **MODEL_INFO 미감지**: ANSI 스트립 후 `Opus4.6·ClaudeMax`처럼 공백 없이 합쳐져 정규식 매칭 실패
4. **STOP 버튼 AWAITING 상태 비활성화**: IDLE → AWAITING_* 전환 규칙 미정의로 상태 전환 블록
5. **`/model` 옵션 목록 미감지**: ANSI 스트립 후 `2.Sonnet`, `❯3.Haiku`처럼 공백 소실로 OPTION_NUMBERED 매칭 실패

### 해결

#### DEFAULT 모드 감지 (output-parser.ts)
- `MODE_DEFAULT = /\?\s*for\s*shortcuts/` 패턴 추가
- `parseModeSwitchLine()`에서 `pendingModeSwitch && MODE_DEFAULT` 시 즉시 `mode_change: default` emit
- 타임아웃 fallback: 2초 내 배너 미감지 시에도 default emit

#### 디바운스 축소 (index.ts)
- 800ms → 100ms (PTY 응답 ~10ms이므로 충분)

#### ANSI 스트립 공백 소실 대응 (output-parser.ts)
- `MODEL_INFO`: `\s+` → `\s*` (모델명 매칭)
- `OPTION_NUMBERED`: `\s+` → `\s*` (옵션 목록 매칭)
- `parseOptions()`: 동일하게 `\s*` 적용

#### STOP/ESC 분리 (stop-button.ts, protocol.ts, index.ts)
- `EscapeCommand` 프로토콜 타입 추가
- PROCESSING → 빨간 STOP (Ctrl+C), AWAITING_* → 주황 ESC (Esc 키)
- Bridge에서 `escape` 커맨드 → PTY에 `\x1b` 전송

#### IDLE → AWAITING_* 전환 허용 (states.ts)
- spinner 없이 바로 permission/option/diff prompt가 오는 경우 대응
- 테스트 업데이트: `IDLE → AWAITING_PERMISSION` 허용으로 변경

#### Mode 아이콘 교체 (generate-icons.mjs)
- gear(⚙️) → cycle arrows(🔄) — "모드 순환" 의미 전달

### 커밋

| Hash | Message |
|------|---------|
| `8e16a22` | fix: detect DEFAULT mode banner and reduce mode switch debounce |
| `234b356` | fix: MODEL_INFO regex tolerates stripped spaces in startup banner |
| (unstaged) | feat: STOP/ESC split, IDLE→AWAITING transitions, option detection fix |

---
