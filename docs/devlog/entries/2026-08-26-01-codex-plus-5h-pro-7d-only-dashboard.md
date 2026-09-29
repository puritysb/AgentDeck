# 2026-08-26 — Codex Plus 5H 복귀와 Pro 7D-only를 모든 좁은 Dashboard가 그대로 말하게 한다

Codex 사용량 생산자는 이미 `windowMinutes`로 5H/7D를 정규화하고 있었지만 세 소비자가
그 계약을 끝까지 지키지 않았다. TUI는 `codexRateLimits`를 받으면서도 Claude 한도만
그렸고, D200H의 고정 3키 usage strip은 Claude 5H/7D + Codex 5H/7D 중 네 번째인 Codex
7D를 버렸다. TTGO/C6 1.47은 Claude 데이터가 있으면 Codex 전체를 숨기고, Pro 단독
상태에서는 존재하지 않는 `CX 5h: --`를 만들었다.

- TUI wide/standard/narrow가 Codex 창을 슬롯명이 아니라 `windowMinutes`로 라벨링한다.
  Plus는 5H+7D, weekly window가 `primary`에 실린 Pro도 7D 한 행만 보인다.
- D200H는 시계 옆 3키 예산을 늘리지 않는다. 4~5개 논리 한도가 들어오면 필요한
  만큼만 같은 제공자의 5H+7D를 한 키의 이중 게이지로 압축한다. 일반 Plus는 Claude
  두 키 + Codex pair 한 키, scoped cap까지 있으면 Claude pair + scoped + Codex pair다.
  물리 기기 정본(shared TS)과 Apple Device Preview Swift 미러를 함께 갱신했다.
- TTGO/C6의 두 텍스트 행은 양 제공자가 있을 때 제공자별 압축 행(`CL 5:… 7:…`,
  `CX 5:… 7:…`)으로 바뀐다. 한 제공자만 있으면 실제로 존재하는 창의 행만 보여
  Pro에 유령 5H가 생기지 않는다. 고정 버퍼만 사용해 no-PSRAM 보드의 heap 계약은
  바꾸지 않았다.
- E3의 “Codex 5H가 영구히 사라졌다”는 과거 주석과 테스트 설명을 현재의 동적
  Plus/Pro 계약으로 정정했다.

검증: Vitest 3,596/3,596, Apple XCTest 684개 중 682 pass·2 skip·0 fail,
`pnpm build`, preview mirror sync, PlatformIO `ttgo` + `esp32_c6_147` 링크 빌드 통과.

---
