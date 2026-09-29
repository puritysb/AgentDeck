# 2026-02-21 — Encoder LCD 디자인 통일 (SVG Pixmap)

### 문제

Response Dial과 Utility Dial이 JSON layout 기반 렌더링 → Voice Dial의 SVG pixmap 렌더링과 시각적 불일치. JSON layout은 그라데이션, 아이콘 크기, 타이포그래피 제어에 한계가 있어 인코더 간 디자인 일체감이 부족.

### 해결

#### 통일된 디자인 언어

Voice Dial의 SVG pixmap 패턴을 모든 인코더에 적용:
- 배경: `#0f172a` (Deep Navy)
- 헤더: 11px bold `#94a3b8` (기능 라벨)
- 중앙: 주요 콘텐츠 (아이콘 or 값, accent color)
- 하단: 2px accent bar

#### SVG Renderer 분리

| Renderer | File | 용도 |
|----------|------|------|
| response-renderer.ts | `renderers/` | IDLE(prompt), PROCESSING, DISCONNECTED, interactive fallback |
| utility-renderer.ts | `renderers/` | generic mode (vol/mic/timer/brt), media mode (track/artist) |
| voice-renderer.ts | `renderers/` | 원형(reference) — Ready, Recording, Transcribing, Error |
| option-renderer.ts | `renderers/` | Encoder Takeover 패널 (Context/Focus/List) |

#### 공용 Pixmap Layout

모든 인코더가 `voice-layout.json` (200x100 pixmap) 사용 — JSON text/bar 레이아웃 폐기.
Manifest, encoder-takeover exit, voice text takeover exit 모두 통일.

### 핵심 설계 결정

- **JSON layout → SVG pixmap**: 그라데이션, 커스텀 폰트, 아이콘 크기, opacity 제어 가능
- **단일 pixmap layout**: `voice-layout.json` 하나로 모든 인코더 통일 (레이아웃 전환 불필요)
- **Renderer 패턴**: 순수 함수 → SVG 문자열 → `svgToDataUrl()` → `setFeedback({ canvas })`
- **디자인 가이드**: `memory/encoder-lcd-design.md`에 토큰/색상/패턴 문서화

### Files

| File | Action |
|------|--------|
| `plugin/src/renderers/response-renderer.ts` | New |
| `plugin/src/renderers/utility-renderer.ts` | New |
| `plugin/src/actions/option-dial.ts` | Modified (JSON → SVG) |
| `plugin/src/actions/utility-dial.ts` | Modified (JSON → SVG) |
| `plugin/src/encoder-takeover.ts` | Modified (exit restore) |
| `plugin/src/actions/voice-dial.ts` | Modified (vt exit restore) |
| `plugin/bound.../manifest.json` | Modified (layout refs) |

---
