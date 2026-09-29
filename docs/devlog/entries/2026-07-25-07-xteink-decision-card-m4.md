# 2026-07-25 — XTeink 포크 방향 확정: 서버-드리븐 Decision Card 펌웨어 (M4 구현)

### 문제
`../crosspoint-agentdeck`(X3/X4)의 AgentDeck 대시보드는 전자책 펌웨어의 부가
기능이었다. 이를 "완결성 있는 단일목적 디바이스"로 발전시키는 방향을 검토 —
ONE/THREAD/PASS/NUDGE 류 컨셉 10개를 어떻게 담을 것인가.

### 해결
컨셉 10개는 전부 데몬 측 모듈로 환원되고, 펌웨어는 **카드 1장 + 소프트키 ≤4 +
물리 결정** 단일 계약만 구현한다(TILE 수렴). 포크 커밋 74a20791 로 M4 구현:
`ViewMode::Card` 전면 결정 카드 — Overview 에서 자동 서페이스(2.5s 입력정지
가드), raw 물리버튼 소프트키(PermissionGate=[Later][Detail][Deny][Allow],
옵션≤3 직접 매핑, >3=커서 강등), 디스미스=콘텐츠 시그니처 8슬롯 링, 프롬프트
해소 시 자동 홈 복귀. **신규 프로토콜 0** — `sessions_list` per-session
question/options/requestId + 기존 `select_option`/`permission_decision` 재사용.
검증: pio green(RAM 35.2%) + host ctest 91/91. 두 기기 SD 에 update.bin 무선
업로드 완료(웹서버 `POST /upload`), 온디바이스 적용/실기 검증은 대기.

### 핵심 설계 결정
- 소프트키는 raw 물리 순서로 바인딩하고 힌트바도 `mapLabels()` 를 우회 — 논리
  리맵과 표시가 어긋날 수 없게. 힌트바 폰트는 라틴 전용이라 CJK 라벨은 본문
  행 + 키캡 번호로 강등.
- ≤4 선택 원칙은 구조로 강제(초과 시 커서 문법 강등). 향후 M7 에서
  `card_show`/`card_action` 프레임을 AgentDeck `shared/src/protocol.ts` 에 먼저
  정의 후 포크 재포팅(클라이언트 계약 규율). InkDeck(상시 USB, 동일 패널급)이
  push 카드 1차 검증 표면. 로드맵 SSOT: 포크 `docs/decision-card.md`.
- gotcha: ISP DNS 가 `.local` 을 공인 IP 로 하이재킹해 `crosspoint.local` 이
  가짜 200 을 반환 — 기기 접근은 데몬 레지스트리/서브넷 스윕의 실제 IP 로.

---
