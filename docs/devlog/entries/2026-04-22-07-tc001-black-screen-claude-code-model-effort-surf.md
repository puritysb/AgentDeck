# 2026-04-22 — TC001 black screen + Claude Code model/effort surface

### 문제

두 개의 별개 이슈가 같은 세션에서 잡힘:

1. **TC001 LED 매트릭스가 간헐적으로 완전 검정으로 가는 현상** — `matrix_pages.cpp:renderAgents` 의 ealry-return 분기 (`if (openclawAlive) return;`) 가 OpenClaw 만 alive 이고 Gateway 인증이 아직 안 끝난 짧은 구간에서 단 하나의 스프라이트도 안 그리고 빠져나감. 크레이피시 그리는 분기는 `connected && gatewayConn` 으로 게이트되어 있어 `gatewayConnected=false` 인 동안 (페어링 핸드셰이크, 토큰 미스매치, WS 재연결, 또는 부팅 직후 sessions_list 가 gateway 인증보다 먼저 도착하는 레이스) 화면 전체가 `fill_solid(Black)` 상태로 `FastLED.show()` 됨.

2. **Claude Code 가 `/model` 로 max/xhigh/default/fast effort 를 토글해도 모든 surface 에 표시 안 됨** — `bridge/src/output-parser.ts:64` 의 `EFFORT_LEVEL` regex 가 `\b(high|medium|low)\s+effort\b` 로 좁혀져 있어 max/xhigh/default/fast 를 묵묵히 드롭. 사용자가 Stream Deck/Dashboard 어디에서도 자기가 선택한 effort 가 무엇인지 못 봄.

### 해결

**1번 (TC001 검정)** — `renderAgents` 에 fallback 분기 추가: `connected && !gatewayConn && openclawAlive` 일 때 x=27 에 매우 어두운 크레이피시 (`CRGB(12,3,3)`) 를 dormant 신호로 그림. `drewCrayfish` 플래그로 그 사실을 추적하여 `cfX = drewCrayfish ? 27 : 32` agent column 배치 계산에 반영. `if (openclawAlive) return;` early-exit 은 그대로 두지만 위쪽에 fallback 크레이피시가 보장되어 화면이 완전 검정이 되지 않음. 같은 파일 `matrix_display.cpp` 에서는 `currentPage` 부팅 기본값을 `USAGE` → `AGENTS` 로 바꾸고 `hasUsageData()` (`fiveHourPercent >= 0`) + `skipEmpty(Page)` 를 도입해 nextPage/prevPage/auto-cycle 이 빈 USAGE 로 이동하지 않게 게이트 (이전 SD/SD+ active-agent 세션 작업과 함께 commit `56ab762d` 에 묶임).

**2번 (effort 표시)** — regex 를 `\b(max|xhigh|high|medium|low|default|fast)\s+effort\b` 로 확장 (`output-parser.ts:64`) + 신규 케이스 5개 테스트 추가. effort 는 이미 state-machine → state_update event → DashboardState 까지 통과하고 있었는데 정작 PTY 파서가 새 라벨을 못 잡아서 항상 null 이 흘러갔음. effort label 을 `SessionInfo` 에도 추가해 sibling/per-button 까지 흘려보내는 cross-platform 배관: TS (`shared/protocol.ts`, `session-aggregator.ts`, `bridge-core.ts`, `daemon-server.ts`, `daemon-ws-client.ts`, `hook-server.ts`, `index.ts`), Swift (`SessionInfo` struct, `DaemonSessionEntry`, `SessionAggregator.swift`, `DaemonServer.sessionToDict` + `/health` payload, `SessionListPanel`), Kotlin (`Protocol.kt`, `EinkAgentColumn.kt`, `SessionListPanel.kt`, `EinkMonitorScreen.kt`). neutral effort 필터 (`medium` 만 dropping) 를 `medium` + `default` 둘 다로 확장 — Claude Code 2.1+ 이 "default" 를 per-model neutral 로 노출하는 변화 반영. SD 키패드 타일 렌더러 (`shared/svg-renderers/session-slot-renderer.ts`) 에 `formatModelEffort()` 헬퍼 추가해 `Opus 4.7 · max` 를 한 줄로 14char budget 안에 표시.

추가로 D200H 에서 어색하게 정지된 stitch line (flowing-light dashed border 가 animation tick 없이 frozen dashes 로 보이던 문제) 도 같은 commit 에 들어감: `BorderStyle` 에 `.processingSolid(color)` 케이스 추가 → solid glowing amber border 로 대체. shared SVG 렌더러도 `options.animated: false` 일 때 dashes 대신 solid border + `▶ RUN` badge 를 그리도록 분기.

### 핵심 설계 결정

- **`if (openclawAlive) return;` 를 보존하되 위에 fallback 크레이피시를 보장** — 문어를 octopus 로 그리지 말자는 원래 의도(OpenClaw 만 있는데 Claude session 이 있는 것처럼 보이는 거 방지) 는 유지하면서 검정 화면만 막음. early-exit 자체를 없애면 OpenClaw 단독 상태에서 octopus + 크레이피시 둘 다 뜨는 문제 발생.
- **D200H 에 `processingSolid` 신규 케이스 추가, `processingDash` 는 삭제 안 함** — animation 이 동작하는 모드 (`d200hStableStockHidEnabled() == false`) 가 다시 생길 가능성 대비. `computeSessionListSlots` 에서 `isStable ? .processingSolid : .processingDash(animFrame)` 로 분기.
- **effort regex 는 whitelist 유지** — `\b(\S+)\s+effort\b` 같은 광범위한 패턴 안 씀. `1. High effort quality\n` 같은 numbered option line 이 false positive 로 잡히는 걸 막는 기존 테스트 (`output-parser.test.ts:3000`) 가 깨질 위험. 새 라벨이 더 등장하면 그때 추가.
- **TC001 펌웨어는 esptool direct + `--flash-size 8MB`** — PIO upload hang 이슈 (`ulanzi-tc001.md` 메모리) + 4MB 로 플래시되면 부트로더 실패해서 부저 계속 울리는 함정 회피. CH340 포트 식별은 `device_info_request` JSON 응답이 아니라 `esptool.py chip_id` 의 `Chip is ESP32-D0WD` 로 — TC001 의 CH340 TX 가 하드웨어적으로 broken 이라 JSON 응답이 안 돌아옴 (대신 ROM bootloader 는 정상 동작).

### 후속

- npm/플러그인/App Store/Android 정식 배포는 안 함 (사용자가 로컬에서 검증 후 결정 예정)
- TC001 펌웨어는 본 세션에서 직접 esptool 로 플래시 완료 (MAC `24:d7:eb:b1:cd:e4` 확인, app-only @ 0x10000)
- 86 Box (ESP32-S3, port `wchusbserial211340`) 는 같은 펌웨어 빌드 대상이 아니므로 별도 빌드/플래시 불필요
- `shared/src/command-builders.ts` 의 auto-generated `clientRegister()` 가 required `clientType` 필드 누락으로 TS 빌드 깨뜨리는 issue 가 있어 한번 수동 시그니처 수정했으나 사용자가 의도적으로 원본 (auto-gen output) 으로 되돌림 — generator 자체에 문제가 있다는 인지가 있는 것으로 보임. 다음 세션에서 manually fix 시도 금지

---
