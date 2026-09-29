# 2026-03-29 — Simulator 기준 전 플랫폼 캐릭터 shape language 통일

### 문제
각 플랫폼 renderer가 독자적으로 캐릭터를 그리고 있어서 simulator(SSOT)와 괴리 발생. Claude는 플랫폼마다 14×5 pixel grid, 8×12 glyph, 6-lobe cloud 등 제각각. OpenCode 캐릭터는 대부분 플랫폼에서 미구현.

### 해결
Simulator `tools/creature-simulator/index.html`의 `PIXEL_GRIDS`를 기준으로 전 플랫폼 정렬:

| 캐릭터 | Simulator Grid | 반영 플랫폼 |
|--------|---------------|------------|
| Claude | 12×8 block glyph (claudecode-color.svg) | ESP32 octopus.cpp, Pixoo |
| Codex | 12×10 smooth pill (codex-color.svg) | ESP32 cloud.cpp, Pixoo, Android E-ink |
| OpenCode | 10×9 nested-square (opencode-logo) | ESP32 (신규), Pixoo (신규), TUI (신규), Android (신규), Apple (신규), Stream Deck (신규) |

### 핵심 설계 결정
- **ESP32 octopus**: 14×5 portrait-rect pixel grid (Android 스타일) → 12×8 square-cell block glyph. arm/leg 셀타입 애니메이션 제거, sparkle line working effect로 대체
- **ESP32 cloud**: 6-blob cumulus circle overlap → 12×10 pill glyph grid. 상단 3행 gradient 유지, >_ prompt overlay 단순화
- **Pixoo creatureTypeFor()**: 2타입(octopus/jellyfish) → 3타입(+opencode). drawOpenCode() 신규 + OpenCode 색상 팔레트
- **TUI OpenCode**: braille가 아닌 box-drawing 문자(┌─┐│└─┘)로 렌더. 유일하게 비생물형 캐릭터
- **Stream Deck watermark**: 72px 통일 (Claude scale 6→4.5, OpenClaw 120→72px). Codex/OpenCode 로고 추가
- **Deploy 스킬**: ESP32 플래시 전 device_info 확인 필수 절차 추가. 포트↔보드 매핑 실수 방지

### 교훈
- ESP32-S3 JTAG 보드(IPS/Round)는 usbmodem 포트가 USB 허브 위치에 따라 변동. **반드시 device_info_request로 보드 식별 후 플래시**. 잘못된 display driver firmware → 화면 안 켜짐 + USB 재등록 실패
- Linter가 코드를 되돌리는 경우가 있으므로, 변경 후 실제 반영 여부를 빌드/grep으로 재확인 필요

---
