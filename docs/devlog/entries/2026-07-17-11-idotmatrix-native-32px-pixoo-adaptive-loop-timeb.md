# 2026-07-17 — iDotMatrix native 32px + Pixoo adaptive loop + Timebox Agent Beacon

### 문제
- Swift iDotMatrix가 Pixoo64 완성 장면을 32px로 절반 축소한 뒤 brightness 1.6 / contrast 1.2를 적용해, 공식 마크가 물리 5–6 LED까지 작아지고 음각·눈이 뭉개졌다.
- Pixoo64는 상태 변화 때만 2프레임을 심고 안정 상태를 단일 프레임으로 덮었으며, 시퀀스가 한 번 실패하면 실행 내내 애니메이션을 포기했다. HTTP 자체보다 업로드 정책이 움직임을 느리게 만든 경우였다.
- Timebox Mini의 별도 hand-authored 11×11 크리처 표는 다른 표면의 공식 마크와 계속 갭을 만들었다. 121 LED에서 테라리엄을 축소하는 접근도 정보 밀도가 지나쳤다.

### 해결
- **iDotMatrix**: Swift `renderCompact32`가 단순화된 수면/지형 위에 최대 3개의 생성 공식 마크를 물리 16/12/9px로 직접 합성한다. 완성 장면 후축소가 없고, 출력 보정은 Swift/Python 모두 1.22 / 1.08로 낮췄다.
- **Pixoo64**: active는 2.5s moving-single, idle 10s, 상태 변화 floor 1s로 바꿨다(기존 active 체감 12s 대비 약 5배 빠름). multi-frame GIF는 실기에서 요청 직후 REST timeout + ping 60–87.5% 유실을 반복 확인해 기본 경로에서 완전히 제외했다. 실패 attempt도 rate-limit하고, 별도 periodic channel reassert가 최근 정상 push를 중복 덮지 않게 했다. 기기는 REST에 응답하지만 장수 URLSession만 고착되는 패턴은 PicID 실패 즉시 fresh probe로 대조해 세션을 재생성한다. 복구 frame 실패를 성공으로 덮던 상태 초기화도 제거했다.
- **Timebox Mini**: 11×11 전용 **Agent Beacon**으로 교체했다. 중앙 9×9은 `design/brand/*.svg`에서 생성한 공식 identity이고, 1px 외곽 rail만 processing cyan chase / awaiting amber corners / error red dash / idle green corners로 움직인다. 기존 수제 대체 크리처 표는 제거했다.

### 검증
`pnpm generate-micro-glyphs` 결정론적 재실행, TypeScript typecheck, 전체 Vitest 102 files / 1,812 tests, Swift Timebox+iDot/Pixoo 정책 집중 tests, macOS Debug build, `git diff --check` 통과. 11×11 5종을 nearest-neighbor 확대 렌더해 공식 실루엣·OpenCode hollow·OpenClaw teal eye·Antigravity 열린 arc를 시각 검수했다. 새 macOS 빌드에서 Timebox/iDotMatrix는 CoreBluetooth connected + 지속 frame update를 실측했다. Pixoo는 multi-frame 실패와 장수-session 고착을 실기 재현한 뒤 안전 단일-frame 빌드에서 `animationMode:single-frame`, `failures:0`, `online:true`, `lastPushError:null`, 2.5s push 갱신과 ping 27회 연속 무손실을 확인했다.

### 핵심 설계 결정
초저해상도는 동일 장면을 축소하는 문제가 아니라 **동일 identity를 각 패널 문법으로 번역하는 문제**다. geometry는 공식 SVG 생성 마스크로 고정하되, 32px는 compact composition, 11px는 stable identity + perimeter status, 64px는 안전한 bounded HTTP cadence로 서로 다른 제약을 직접 다룬다. Pixoo BLE 비공개 프로토콜을 새로 역공학하지 않고 공식 LAN REST 면을 사용한다.
