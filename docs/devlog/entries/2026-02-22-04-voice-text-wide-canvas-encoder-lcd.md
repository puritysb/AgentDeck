# 2026-02-22 — Voice Text Wide Canvas + Encoder LCD 디자인 일관성 정비

### 문제

1. **전사 텍스트 가독성**: VT(Voice Text Takeover)가 패널별 독립 SVG → 텍스트가 패널 경계에서 끊김, 짧은 텍스트가 좁은 1패널에 갇힘
2. **인코더 디자인 불일치**: 4개 다이얼(VOL, PROMPT, TERM, VOICE)의 헤더 정렬·폰트·바 높이·아이콘 크기가 제각각
3. **Utility 모드 타이틀에 emoji 혼재**: "🔊 Vol", "☀️ Bright" 등 타이틀에 emoji가 포함되어 디자인 일관성 저해

### 해결

#### Voice Text Wide Canvas

전체 인코더(최대 4패널 × 200px = 800px)를 하나의 와이드 캔버스로 렌더링:

- **translate 슬라이싱**: `<g transform="translate(${-i*W},0)">` — SD의 viewBox offset 미지원 우회
- **clipPath 스크롤**: 텍스트 영역 y=22..80 클리핑, `translate(0,${-scrollY})` 픽셀 스크롤
- **적응형 폰트 5단계**: 48→36→24→18→16px, 짧은 텍스트는 크게, 긴 텍스트는 작게
- **가운데 정렬**: 가로 `text-anchor="middle"`, 세로 자동 중앙 배치
- **hint pills**: `tap ✓` / `hold ✕` (50×16, 56×16, 13px bold)
- **VT 잔상 제거**: exit 시 blank SVG로 모든 패널 원자적 초기화, interactive 상태 진입 시 선제적 VT 종료

#### 인코더 LCD 디자인 일관성

**통일 규칙 확정**:

| 요소 | 규격 |
|------|------|
| Header | 14px bold, `#94a3b8`, `text-anchor="middle" x="100"` |
| Counter | 11px `#475569`, `text-anchor="end" x="190"` |
| Icon (active) | 28px, accent color |
| Icon (disabled) | 22px, `#475569` opacity=0.5 |
| Bar (data) | `x=10 w=180 h=2 rx=1`, track `#1e293b` + fill |
| Bar (decorative) | `x=60 w=80 h=2 rx=1`, accent opacity=0.2 |

**수정 사항**:
- Voice/Response/iTerm: 헤더 LEFT→CENTER 정렬 통일
- iTerm Panel: y=14/11px/#06b6d4 → y=18/14px/#94a3b8
- Response Interactive: bar h=3→2, counter #64748b→#475569
- Response Disabled: icon 28→22px

#### Utility 모드 Icon+Value 분리

**이전**: 타이틀에 emoji 포함 ("🔊 Vol"), value만 독립 표시
**이후**: 깔끔한 영문 타이틀 ("VOL") + icon+value 가운데 그룹 렌더링

| Mode | title | icon | value |
|------|-------|------|-------|
| Volume | VOL | 🔊/🔇 | 50% / Muted |
| Mic | MIC | 🎙 | 80% / Muted |
| Brightness | BRT | ☀️ | 50% |
| Timer | TIMER | ⏱️ | 05:00 |
| Dark Mode | THEME | 🌙/☀️ | Dark / Light |
| Media | MEDIA | ▶/⏸ | (track name) |

Icon+Value 그룹 가운데 정렬:
```typescript
const groupX = Math.round(100 - (iconPx + gap + valPx) / 2);
```

### 핵심 설계 결정

- **translate > viewBox**: SD SVG 렌더러가 non-origin viewBox offset 무시 → translate로 우회
- **헤더 항상 가운데**: 모든 상태·모든 다이얼에서 일관된 시각적 무게중심
- **Icon+Value 그룹 정렬**: 폭 추정(emoji=1em, char≈0.55em) 기반 동적 offset → 자연스러운 간격
- **Space width 보정**: Arial space ≈ 0.28em (기존 0.55em 오류 수정) → 정확한 줄바꿈

### Files

| File | Action |
|------|--------|
| `plugin/src/renderers/voice-renderer.ts` | Modified — wide canvas, adaptive font, center align |
| `plugin/src/renderers/utility-renderer.ts` | Modified — icon+value group, center header, media icon |
| `plugin/src/renderers/response-renderer.ts` | Modified — center header, bar h=2, disabled icon 22px |
| `plugin/src/renderers/iterm-renderer.ts` | Modified — center header, panel header 14px/#94a3b8 |
| `plugin/src/actions/voice-dial.ts` | Modified — pixel scroll, wide canvas VT, atomic exit |
| `plugin/src/actions/utility-dial.ts` | Modified — pass icon field |
| `plugin/src/plugin.ts` | Modified — VT exit before takeover |
| `plugin/src/utility-modes/volume.ts` | Modified — title/icon 분리 |
| `plugin/src/utility-modes/mic.ts` | Modified — title/icon 분리 |
| `plugin/src/utility-modes/brightness.ts` | Modified — title/icon 분리 |
| `plugin/src/utility-modes/timer.ts` | Modified — title/icon 분리 |
| `plugin/src/utility-modes/darkmode.ts` | Modified — title/icon 분리 |
| `plugin/src/utility-modes/media.ts` | Modified — title/icon 분리 |

---
