# 2026-07-18 — Stream Deck Mini 번들 프로파일 추가

- Stream Deck Mini(DeviceType 1, 3×2)를 `agentdeck-sdmini` 번들 프로파일로 추가했다. 구형 `.sdProfile`과 현행 `.streamDeckProfile` 포맷을 함께 제공하며 여섯 키 모두 session-slot 액션으로 초기화한다.
- 플러그인 연결 시 Mini를 감지하면 전용 프로파일로 자동 전환하고, 통합 버전 검증에 두 Mini 프로파일 manifest를 포함했다. XL(DeviceType 2)은 동적 그리드 계산만 있고 번들 프로파일은 아직 없다.
- `pnpm verify-version`, Mini 중심 슬롯·세션 배치 테스트 41/41, `pnpm build`, `pnpm package`, `streamdeck validate`를 통과했다. 생성된 196KB 아카이브에 Mini의 두 프로파일 포맷과 page manifest가 모두 포함됐다.
