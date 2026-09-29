# 2026-02-22 — Response Dial 통합 (Option Selector + Quick Prompt → 단일 인코더)

### 문제

E2(Option Selector)는 선택지가 없는 IDLE 상태에서 "Ready"만 표시 — 슬롯 낭비. E3(Quick Prompt)는 IDLE에서 프롬프트 전송 + 선택지 있을 때 takeover List 뷰 표시. 두 다이얼이 rotate=탐색/push=확정이라는 동일 UX 패턴을 상황에 따라 다르게 쓸 뿐이라 인코더 슬롯 낭비.

### 해결

**Response Dial** (`option-dial` UUID 유지):
- IDLE: rotate → 프롬프트 목록 순환, push → 선택된 프롬프트 전송
- Interactive (AWAITING_OPTION/PERMISSION/DIFF): rotate → 옵션 스크롤, push → 선택 확정
- PI 설정(`response-dial-pi.html`)으로 커스텀 프롬프트 목록 지원

**Takeover 패널 재편** (E3 슬롯 해제):

| 슬롯 | 평소 | Takeover 중 |
|------|------|-------------|
| E1 (Utility) | Utility | Context (상태·툴·질문) |
| E2 (Response Dial) | Prompt 목록 | Focus (선택 옵션, 대형 폰트) |
| E4 (Voice) | Voice | List (옵션 목록, 스크롤) |

voiceIds가 기존 Detail 패널 역할 대신 List 패널을 담당 → 3패널 경험 유지.

**렌더링 개선** (option-renderer.ts):
- Focus 패널: 옵션 이름 24px (기존 16-20px), sub 13px, position counter 제거
- List 패널: 행 폰트 15px, 행 높이 22px, 배지 제거 (색상으로만 구분)
- Context 패널: 툴 라벨 18px bold, 질문 텍스트 13px, hint 텍스트 제거

### 핵심 설계 결정

- **UUID 유지**: `bound.serendipity.agentdeck.option-dial` — 배포 후 변경 불가, 기능만 확장
- **단일 다이얼 이중 모드**: `isInteractive()` 분기로 IDLE/interactive 동작 전환
- **voiceIds → List**: Detail 패널 폐기, List가 더 유용 (전체 옵션 목록 스크롤)
- **배지 제거 from List**: Focus에만 유지, List는 row 배경색으로 구분

### Files

| File | Action |
|------|--------|
| `plugin/src/actions/option-dial.ts` | Modified — IDLE prompt 순환·전송 추가, class → ResponseDialAction |
| `plugin/src/actions/command-dial.ts` | **Deleted** |
| `plugin/src/encoder-registry.ts` | Modified — commandIds 제거 |
| `plugin/src/encoder-takeover.ts` | Modified — voiceIds → List 패널, commandIds 참조 제거 |
| `plugin/src/plugin.ts` | Modified — CommandDialAction 제거 |
| `plugin/src/renderers/option-renderer.ts` | Modified — 폰트 증가, hint 제거, List 배지 제거 |
| `plugin/bound.../manifest.json` | Modified — "Quick Prompt" 제거, "Response Dial" 이름 변경 |
| `plugin/bound.../ui/response-dial-pi.html` | New |
| `plugin/bound.../ui/command-dial-pi.html` | **Deleted** |

---
