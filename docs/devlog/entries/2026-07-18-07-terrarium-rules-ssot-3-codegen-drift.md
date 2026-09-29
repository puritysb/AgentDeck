# 2026-07-18 — Terrarium rules SSOT: 손미러 3곳 체제를 codegen+drift 게이트로 교체

- idle 바닥수렴/crayfish 제외(610fe15c) 계약이 Swift·Android에만 손미러로 반영되고 TUI·ESP32에는 같은 버그가 살아 있는 파편화를 구조적으로 해소했다. `shared/src/terrarium-rules.ts`가 크로스플랫폼 터라리움 **룰**(crayfish 홈/영토, clear 앵커 0.62, 바닥휴식·hover strip)의 SSOT이고, `pnpm generate-terrarium-rules`가 Swift/Kotlin/C++ 미러를 생성한다. 표면별 **튜닝**(보드별 Y, swim lane)은 로컬에 남긴다.
- `shared/src/__tests__/terrarium-rules.test.ts`가 소스 재-emit과 디스크 미러를 diff해 손편집/재생성 누락을 CI에서 실패시키고, clearance 불변식(clearMaxX + 최대 rester 반폭 < crayfish 집게 좌단)도 한곳에서 검증한다.
- 소비자 연결: Swift/Android TerrariumConfig는 생성 상수 참조로 전환. ESP32 sleeping OpenCode/Antigravity(앵커 0.63–0.74가 crayfish 자리 0.72–0.78과 겹침)와 TUI(opencode homeX 0.68·jellyfish 드리프트 0.65 vs crayfish 0.75)에 클램프를 적용해 잔존 버그를 해소했다.
- 작업 규칙 갱신: CLAUDE.md Key Conventions에 "Cross-platform rules are SSOT-first" 원칙과 캐노니컬 소스 목록을 추가하고, 실제 CLI와 어긋난 Module flags 문서(`--no-mdns`/`--no-serial`/`--no-pixoo`는 존재하지 않음 — 하드웨어 모듈은 데몬 전용)를 바로잡았다.
- 검증: vitest 1889 green, Android `testDebugUnitTest` green, `AgentDeck_macOS` Debug 빌드 green, ESP32 host sim 렌더 정상. Android 실기 3대(Crema S/Lenovo/Pantone6) screencap으로 idle OpenCode×2 + OpenClaw 활성 분리 렌더링도 확인.
