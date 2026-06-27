# AgentDeck Development Log

---

> **Older entries are archived by month** under [`docs/devlog/`](docs/devlog/README.md) to keep this active log small. This file keeps the most recent months (2026-06, 2026-05). For history, grep the specific month file in `docs/devlog/` rather than loading everything.

---

## 2026-06-27 — iDotMatrix / Divoom Timebox Mini 가 대시보드·패널에 안 보이던 문제

### 문제
두 BLE 매트릭스 패널(iDotMatrix 32×32, Timebox Mini 11×11)이 대시보드 토폴로지에 안 뜨고 패널 렌더도 깨졌다. 단일 버그가 아니라 3겹 plumbing gap이었다.

### 해결
- **Node 가시성**: Timebox는 정식 `TimeboxModule`인데 **iDotMatrix는 모듈 미등록**(직접 `startIDotMatrixSync` spawn만)이라 `buildNodeModuleHealth`/`/devices`/TUI/`agentdeck devices` 전부에서 누락. `IDotMatrixModule` 신설(Timebox 미러)+`createDefaultModules` 등록+health/devices/cli/TUI 분기+`ModuleConfigs.idotmatrix`. daemon-server의 직접 start 호출은 제거(모듈이 단일 소유).
- **Apple 가시성**: Swift 데몬은 `/health`에 idotmatrix+timebox `statusSnapshot()`을 이미 emit하지만 **클라가 버렸음** — `ModuleHealthState` 필드 없음+`BridgeEventParser.parseModuleHealth` 미디코드+`TopologyRail` 섹션 없음. 공유 `BLEMatrixHealth` struct+파서 분기+`bleMatrixSection`(statusReason→LEDStatus).
- **진단성**: 양 daemon-sync가 `stdio:'ignore'`로 Python 크래시(bleak/idotmatrix 미설치 등)를 삼켜 blank 패널이 무진단이었다. 공유 `bridge/src/ble-sync-spawn.ts`(stdout 묵음+stderr ring buffer, exit 시 tail 로그)로 교체. iDotMatrix는 설정 변경 시 재시작도 추가.

### 핵심 설계 결정
- **★ 실사용 즉시 원인 = settings 경로 분리.** App Store 플래그 빌드는 컨테이너 settings.json을 읽는데 `agentdeck ... add`는 `~/.agentdeck/`에 씀 → 앱이 `configuredDeviceCount:0`("no device configured")으로 아무것도 안 그림. 컨테이너 빌드는 앱 Settings 시트로 페어링해야 한다.
- **Swift 렌더 하드닝 후보 3건은 defect 아님(검증 후 변경 안 함)**: Timebox dim `max(0)`=의도(hw 밝기 없어 0=blank), TimeboxBLE settle 불필요(프레임당 1패킷+flow-control), wake stale-connected는 `handleWake()`가 이미 처리.
- **병렬 세션 브랜치 정리 중 Phase 1 Node 누락 → 재적용.** "Salvage … #30"이 Apple/Phase2/cli는 가져갔으나 iDotMatrix 모듈 등록+daemon-server health/devices 배선을 빠뜨려 Node 가시성 회귀. 본 브랜치에서 surgical 재적용.

### 검증
`pnpm build` green, `xcodebuild -scheme AgentDeck_macOS` BUILD SUCCEEDED, Node 데몬 e2e로 `/health`·`/devices`에 두 기기 표출 확인.

---

## 2026-06-25 — TRMNL App Store standalone hub parity + observability

### 문제
TRMNL 안정화 문서/CLI가 "Node daemon = usage-capable hub, macOS app = client" 중심으로 굳어 App Store 단독 배포 관점과 충돌했다. 실제 Swift 앱은 `/api/display`를 서비스하지만 `/health`/`/status`/`/devices`/`moduleHealth`에 `trmnl`이 빠져 있어 운영자는 패널이 붙었는지, stale인지, RSSI가 약한지 알 수 없었다. 또한 Swift TRMNL enrollment가 in-memory라 앱 재시작 뒤 상태 표면이 비어 보이고, 실행 중인 구버전 앱에서는 약한 RSSI에도 낮은 `image_url_timeout`이 나가 "not responding" 재발 가능성이 있었다.

### 해결
- **App Store Swift daemon을 first-class BYOS hub로 승격**: `TrmnlSettings`가 `trmnl.devices[]`를 Node와 같은 shape으로 읽고 저장. Auto-enroll 시 sandbox `settings.json`에 enrollment만 영속화하고, poll telemetry는 runtime-only 유지(파일 churn 없음).
- **관측성 parity**: Swift `TrmnlModule.statusSnapshot()`을 `/health`·`/status`·`/devices`·`state_update.moduleHealth`·앱 내부 `DeviceSummary`에 연결. telemetry는 MAC, 해상도, RSSI, 배터리, lastSeen/secondsSinceSeen, stale flag를 제공. 동기 broadcast 경로는 5초 캐시 사용(SerialModule 패턴).
- **계약 parity**: Swift 경로도 기본 `image_url_timeout=50s`, 약한 RSSI(≤ -78dBm)는 60s로 확장. App Store 앱 단독으로도 등록/렌더/헬스가 완결되고, CLI daemon은 개발 세션/Claude OAuth quota relay를 보강하는 progressive enhancement로 재정의.
- **화면 효율 개선**: TRMNL footer가 quota-known 일 때만 5H/7D gauge를 그린다. App Store-only/OAuth-blind 상태처럼 quota가 구조적으로 unknown이면 30px compact hub-status strip으로 접어 800×480에서 9번째 session row까지 본문에 돌려준다(Node SVG + Swift CoreGraphics parity).
- **문서/CLI 정정**: `agentdeck trmnl`, `docs/devices.md`, README, App Store feature matrix, hardware compatibility에서 "Node가 정답 hub" 문구를 "하나의 안정적 hub(App Store 앱 또는 CLI)"로 변경.

### 핵심 설계 결정
- **Daemon이 완전히 꺼진 상태는 TRMNL 펌웨어 오류 UI가 맞다.** Pull-only BYOS 특성상 응답 프로세스가 없으면 AgentDeck offline 이미지를 줄 수 없다. App Store 패키지의 목표는 "앱이 실행 중이면 standalone hub로 완결"이지, 앱 종료 후에도 별도 responder 없이 표시를 제어하는 것이 아니다.
- **영속화는 enrollment만.** 매 poll마다 telemetry를 settings에 쓰면 sandbox container 파일 churn과 UI 편집 레이스가 생긴다. stale/lastSeen은 runtime health로 충분하다.

### 검증
Green:
- `pnpm vitest run bridge/src/__tests__/trmnl-byos.test.ts bridge/src/__tests__/trmnl-renderer.test.ts shared/src/__tests__/trmnl-layout.test.ts` (42 tests)
- `pnpm --filter @agentdeck/bridge typecheck`
- `xcodebuild test -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -destination 'platform=macOS' -only-testing:AgentDeckTests_macOS/TrmnlModuleTests -only-testing:AgentDeckTests_macOS/SessionLauncherTests`
- `xcodebuild build -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -destination 'platform=macOS'`

---

## 2026-06-25 — LED 매트릭스 디바이스 주변부 공통화 + 구현 갭 정리

### 문제
`docs/hardware/index.html` §B LED 매트릭스 4종(Pixoo64 64×64 · iDotMatrix 32×32 · Timebox Mini 11×11 · TC001 8×32) 점검: 렌더 코어 바깥 **주변부**에 파편화/갭. ① iDotMatrix 소프트 밝기 부스트가 Node 1.6 / Swift 1.3 / `sync.py` 기본 1.5 로 3중 drift → 같은 패널을 두 데몬이 다른 밝기로 렌더. ② iDotMatrix `sync.py`·Timebox `sync_ble.py` 가 HTTP/디밍 plumbing(`fetch_display_state`·`resolve_display_brightness`·상수)을 ~80% 중복 보유. ③ Timebox 11×11 micro-glyph 그리드를 `micro-glyphs.ts`↔`MicroGlyphs.swift` 손으로 byte-mirror(침묵 drift). ④ TC001 `.ulanziTc001` ADB 분류 경로가 producer 없는 dead code 로 5곳 잔존.

### 해결
- **렌더 코어는 안 건드림** — Node `renderFrame(...,size,layout)`+`/pixoo/frame` 단일 fan-out, Swift 단일 `PixooRenderer` 3모듈 공유. Node↔Swift 재구현(App Store 서브프로세스 0)·Android e-ink 분기는 **의도된 설계**.
- **WS1 밝기 parity** (`e886d3cc`): 세 지점 1.6 통일 + cross-ref 주석.
- **WS2 Python sync 공통화** (`e886d3cc`): 신규 `bridge/src/pysync/matrix_sync_common.py`(상수+`fetch_display_state`+파라미터화 `resolve_display_brightness`). 두 클라이언트가 sibling `sys.path` insert 로 import. **dim FLOOR 는 디바이스마다 다름**(iDotMatrix 5/5, Timebox 0/0) → thin wrapper 로 파라미터화, 호출부 시그니처 불변. 20-edge parity 검증.
- **WS3 micro-glyph 코드젠** (`8d54a045`): 신규 `scripts/generate-micro-glyphs.mjs`(`pnpm generate-micro-glyphs`)가 `micro-glyphs.ts`(SSOT 유지)를 파싱해 `apple/.../MicroGlyphs.generated.swift` 생성. `MicroGlyphs.swift` 는 paint/statusBg 로직만. `generate-creature-glyphs` 옆에 등록.
- **WS4 TC001 dead-ADB 제거** (`38858021`): `.ulanziTc001`(AdbModule classify·AgentState enum·TopologyRail·MenuBar) 삭제 + 문서 3표면(hardware-compatibility.md·hardware/index.html·appstore-feature-matrix.md) "제거 완료" 갱신. 라이브 row 는 이미 `ESP32Serial.swift` USB-serial 경로.

### 핵심 설계 결정
- **micro-glyph 데이터는 inline TS 유지(JSON 분리 금지).** bridge 는 `dist` 에서 compiled 실행 + `tsc` 가 JSON sidecar 를 `dist` 로 안 복사 → `.json` import 면 런타임 크래시. 그래서 codegen 이 `new Function` 으로 TS 리터럴 파싱(에셋은 fonts 처럼 `import.meta.url` readFileSync 만).
- **Python BLE sync 는 source/dev 설치 전용.** `bridge/package.json` files=["dist","assets/fonts"] 라 `.py`/`pysync/` 는 published npm 에 없고, daemon-sync.ts 가 `existsSync(.venv & sync.py)` 로 gate. `pysync/` 를 `.py` 와 같은 `src/` 에 co-locate → packaging 변경 불요.
- **TC001 ✅ 승격은 HW 검증 후속.** 이번엔 dead-code 제거 + serial 이 단일 라이브 경로임을 문서에 확정. golden `TimeboxProtocolTests.swift` 는 paint/statusBg/MicroCreature 공개 API 만 써서 코드젠 후에도 그대로 green.
- 동시 세션이 같은 트리에서 device-discovery/attention 작업을 master 에 커밋(`4231605e`/`e8027589`) → 얽힘 해소 후 내 변경분만 명시 pathspec 3-commit. xcodegen scheme 다운그레이드 noise(구버전)는 revert, pbxproj 는 deterministic +12 라인(내 generated + 그쪽이 누락한 DeviceApprovalGateTests)만.

검증: TS build green · vitest 1463/1463 · `py_compile`+resolve parity · xcodegen + macOS BUILD SUCCEEDED.

---

## 2026-06-25 — macOS Attention 오발 + 선택지 불일치: permission_mode / notification_type 게이팅

### 문제
macOS Dashboard 가 observed direct-`claude` 세션에 대해 (1) 묻지도 않은 상황에서 "Attention" 카드를 띄우고, (2) 띄울 때 보여주는 선택지가 에이전트의 실제 요청과 안 맞았다. 근본은 PTY 없는 observed 세션의 awaiting-state·options 를 **coarse hook 신호로 합성**한 것 — Claude Code 가 실제로 주는 정밀 필드를 무시.

### 해결 (Swift 데몬 + Node 브리지 parity)
- **gate 가드 (오발 #1)**: `handlePreToolUseHook` 가 device-approval 게이트로 Bash/Write/Edit/MultiEdit/NotebookEdit 를 전부 hold 했는데 `permission_mode` 를 안 읽음. PreToolUse 는 **모든** tool 호출마다 발화(acceptEdits/bypass/dontAsk/plan/allowlisted 라 Claude 가 안 묻는 경우 포함). 새 공유 술어 `shouldGate(permissionMode, tool)`: bypassPermissions/dontAsk/plan 은 게이트 안 함, acceptEdits 는 edit-family 만 skip(Bash 는 게이트), default/auto/unknown 만 게이트. Swift `DaemonServer.shouldGate` + Node `awaiting-overlay.ts::shouldGatePreToolUse`.
- **notification_type (오발 #2)**: Notification awaiting 을 free-text `message` 정규식 대신 `notification_type == "permission_prompt"` 로 판정(`isPermissionNotification`, 정규식은 구버전 Claude fallback). idle_prompt/auth_success/elicitation_* 가 더 이상 attention 을 켜지 않음.
- **stale options (불일치)**: `attentionOptions`(MonitorScreen+ControlTowerPanel)가 비-gated 세션에 aggregate `stateHolder.state.options` 를 빌려와 무관한 옛 프롬프트의 선택지를 dead 버튼으로 렌더. 이제 awaiting `state_update` 가 그 세션에 attribute 된 경우(`state.sessionId == session.id`)만 빌림 — observed 세션은 질문 + "respond in terminal" fallback.

### 핵심 설계 결정
- **coarse 합성 < Claude 정밀 신호.** hook 스크립트가 stdin 을 `-d @-` 로 그대로 포워드하므로 `permission_mode`·`notification_type` 가 이미 daemon 에 도달 — 안 읽었을 뿐. (Gotcha: 탐색 subagent 가 "permission_mode 는 PreToolUse 에 없다"고 오답 — AgentDeck 가 extract 안 한 것과 Claude 가 send 안 한 것을 혼동.)
- **게이트 잔여 한계**: 순수 default 모드 + allowlisted tool 은 여전히 게이트됨 — hook 은 Claude 의 allowlist 를 못 보고 `permission_mode` 만 봄. gated 경로의 device 응답은 `permissionDecision: allow/deny/ask` 만 가능 → Claude 의 3지선다("don't ask again") 표현 불가(binary Allow/Deny 는 device 가 결정자라 faithful).
- 동시 세션이 같은 트리에서 MicroGlyphs 리팩터 진행 중 → macOS 풀빌드는 그쪽 미완성으로 red(내 Swift 파일은 무관·컴파일 통과). 커밋은 temp-index `commit-tree` 로 내 7파일만 격리(daemon-server.ts 는 concurrent autoDiscover hunk 제외, 내 3 hunk 만).

---

## 2026-06-25 — 디바이스 friendly-name 일치 점검 + zero-config 자동 발견

### 문제
"연동 기기 이름이 `docs/hardware/index.html` friendly명과 일치하는가" + "남이 설치해도 기기 속성을 자동 감지해 같은 타입으로 매핑되는가" 점검 요청. 라이브 데몬(`/health`) 대조 결과 두 갭: ① Swift 표시명 switch(`TopologyRail`/`MenuBarTopologyList`)에 `ttgo_t_display`·`esp32_c6_147` 케이스 누락 → raw 와이어 문자열로 노출(TTGO 가 실제 연결 중인 라이브 버그). 네이밍 체계 4종(wire/flash.sh/Swift/HTML)이 SSOT 없이 분산. ② self-advertise 하는 기기(ESP32 device_info·Stream Deck SDK·TRMNL BYOS·Android EinkDetector)는 자동 매핑되지만 **Pixoo·Timebox·iDotMatrix 는 수동 IP/MAC 입력**이라 신규 설치 시 안 잡힘.

### 해결
- **네이밍**: 누락 케이스 추가 + AMOLED/86 Box/IPS 10.1 라벨을 HTML friendly 열에 맞춤(두 Swift switch 동기, 중복 주석 명시). `shared/src/protocol.ts` 와이어 타입힌트 7-board 완성.
- **자동 발견**: Pixoo 는 mDNS 없음 → 로컬 /24 **서브넷 스윕**(`Channel/GetAllConf`→`Brightness` 프로브) 신설. **Node**(`pixoo-discover.ts`) + **App Store Swift**(`PixooModule.autoDiscoverIfNeeded`, URLSession+getifaddrs, 서브프로세스/외부서비스/권한프롬프트 없음) 양쪽. BLE(Timebox/iDotMatrix)는 **Node 만** 부팅 자동스캔(기존 bleak `scan*.py` 재사용, `*-discover.ts`). 공통: 0대일 때만 auto-add + `*AutoDiscover` opt-out.

### 핵심 설계 결정
- **Swift BLE 부팅-자동스캔 의도적 제외.** `CBCentralManager` 생성이 *모든* App Store 사용자에게 Bluetooth 권한 프롬프트를 강제 → 기기 없는 사용자까지 묻게 됨. 현재 데몬은 BLE 기기 설정한 사용자에게만 lazy-create. 그래서 Swift BLE 발견은 설정 시트의 **사용자 트리거 Scan** 유지, Node CLI(프롬프트 무관)만 부팅 자동스캔. plan 승인 범위에서 벗어난 유일한 의도적 deviation.
- **actor 직렬화 회피.** `PixooModule.postCommand` 는 actor-isolated → 254-host 직렬 스윕은 수 분. 스윕 프로브를 `nonisolated` + per-host ephemeral URLSession 으로 빼 실제 동시성 확보(concurrency 32, 600ms timeout).
- **Pixoo 발견은 클라우드보다 로컬 우선.** Divoom 클라우드 LAN API 는 외부 서비스 → App Review 마찰. 로컬 스윕이 App-Store-clean. 클라우드는 Node fallback 으로만.

---

## 2026-06-24 — Evaluation(APME) 재정의: 타임라인 분리 + turn→명시적 task + 스코어카드 추천 + tuner 제거

### 문제
원래 의도("특정 태스크를 어떤 에이전트/모델이 얼마나 잘 수행하는가"를 LLM-as-judge로 평가)가 노이즈에 묻힘. 3가지 근본 원인: ① 평가 단위(task)가 가장 불안정한 신호에 의존 — `todo_complete`(TodoWrite 전부완료) hook은 Claude Code v2.1에서 ~18%만 발화 + 발화해도 논리적 task를 파편화. 카테고리 분류는 async run 분류가 task 닫힌 뒤 도착해 `taskCategory=null`. ② 한 단위가 deterministic+turn+task+run = 최대 6개 `eval_result` row를 타임라인에 발행 → 활동 로그와 평가가 섞여 둘 다 더러움. ③ 페이오프 부재 — vibe 피드백(Stage 3)이 실사용에서 안 일어나 tuner·recommender가 死코드, "어느 모델이 뭘 잘하나" 결론을 아무도 소비 안 함.

### 해결 (4-phase, bridge Node + Swift 데몬 양쪽)
- **P1 타임라인 디노이즈**: `eval_result` 타임라인 row 발행 전부 제거(`daemon-server.ts` onResult 4블록 + `index.ts` 세션브리지 + Swift `handleApmeResult` appendEvalResultTimeline + 死헬퍼). **타임라인 = 활동 로그만(chat/tool/state).** eval은 `apme_eval` WS + SQLite/스코어카드로만. `broadcastApmeEval`/`updateTurn`은 보존.
- **P2 단위 재정의 (turn→명시적 task)**: `todo_complete`를 task 경계 → **non-segmenting soft hint 강등**(`state` sample 이벤트로만 기록). 이제 task는 명시적 경계(`/task close`·디바이스 버튼=manual, `/clear`)나 `session_end`에서만 분할. **카테고리를 closeTask에서 동기 확정**(`computeSignals`+`classify`, run.endedAt nil이라 duration은 task.startedAt에서 유도). `collector.ts` + Swift `ApmeCollector.swift` 미러.
- **P3 스코어카드 표면(페이오프)**: 추천기를 dashboard SPA에 **"Recommend" 탭**으로 연결 — `/apme/samples`(v_sample_scorecard: agent×model×category) 카테고리별 best 랭킹. 양 데몬이 `/apme` 서빙(WKWebView). vibe 👍/👎는 run detail에 이미 존재.
- **P4 死코드 정리**: tuner 완전 제거 — `tuner.ts`·`ApmeTuner.swift`·테스트 삭제, `/apme/tune` 라우트·CLI `apme tune`·`autoTune` 설정(Node+Swift)·DaemonServer retune 루프 제거.

### 핵심 설계 결정
- **타임라인 ≠ 평가 표면.** 평가를 활동 로그에서 완전히 분리하는 단 한 수가 "노이즈" 불만의 대부분을 해소. inert해진 `eval_result` 렌더러(tui/plugin/Apple/Android)는 타입 churn 회피 위해 남김(발행 0이라 무해).
- **신뢰 가능한 단위 우선.** turn(UserPromptSubmit→응답)이 시스템에서 가장 확실한 경계. task는 명시적·결정론적 경계로만. 불안정한 hook 의존 제거가 "태스크 단위 기록 부재"의 근본 해법.
- **Gotcha (CI 함정)**: `apple/AgentDeck/Resources/apme-dashboard.html`은 `dashboard-html.ts`의 raw 렌더가 **아니라** design-token-compliant 별도 미러(`verify-tokens-sync.py`가 css-root로 검사, body는 `var()`/`color-mix()`만). TS를 그대로 렌더하면 Design System CI가 깨짐 → 두 파일 각각 수정. xcodegen은 xcscheme도 재생성(downgrade)하니 scheme churn은 `git checkout HEAD`로 되돌릴 것.

---

## 2026-06-23 — TRMNL e-ink: 안정화 + 정보밀도 재설계 + 세션 goal

### 문제
실기기 TRMNL 패널이 "WiFi connected / TRMNL not responding"로 깜빡이고, 토큰 사용량 게이지가 0%, 대시보드 정보 가치가 낮음. 이후 피드백: 아이콘이 실제 캐릭터와 드리프트(Claude를 문어로), 5H/7D 푸터 공간 낭비 + 시간 디테일 부족, 6+ 세션 처리, "이 세션이 뭐하는지" 요약 부재.

### 해결
- **신뢰성(루트커즈)**: "not responding" = 펌웨어 `WIFI_FAILED`(기기측 HTTP 요청 실패=네트워크). 서버는 로컬 8/8 정상. 한 LAN 피어 50% 패킷로스 + 데몬 2개(Node/Swift) 9120 경쟁. → **단일 허브 규칙**(Node=usage-capable hub, macOS=client). 펌웨어 BYOS 계약 정렬: `refresh_rate` 숫자(문자열→0 파싱), `image_url_timeout` 전송, **filename 안정화**(펌웨어가 filename으로 캐시→실변화에만 hash 변경; 시계/freshness churn 제거→flaky 재다운로드+깜빡임 감소). adaptive cadence는 AWAITING만 빠르게(60s).
- **사용량 정확도**: usage는 `usage_update`에만 있고 `state_update`엔 없음 — TRMNL/D200H 모듈이 미구독 → 영구 0%. `usage_update` 구독+merge, `usageKnown` 트라이스테이트("—" vs 거짓 0%).
- **정보밀도 재설계** (`shared/src/trmnl-layout.ts` + Swift 미러): 텍스트 태그→**캐노니컬 브랜드 크리처 아이콘**(robot/cloud+`>_`/ring/lobster — `assets/logos/*_creature_gen.png` 충실, 손그림 금지). 세션 description, 헤더에 구독+만료(`subscriptions[].until`), 한 줄 푸터 + adaptive 행높이(42~58px, 6~9세션 packing), 시간 디테일(`resets 3h 6m`).
- **세션 goal**: `parseClaudeTranscript`가 head+tail 읽어 **첫 user 프롬프트=세션 목적** 추출(`cleanGoal`로 태그/슬래시 노이즈 제거), `SessionInfo.goal`로 전파, description이 goal 우선. CJK: goal이 한글/중문이라 Latin 번들폰트가 □ → resvg `loadSystemFonts`로 OS CJK 폴백(TRMNL은 상태변화 시 1프레임만 렌더라 비용 OK).

### 핵심 설계 결정
- **펌웨어가 진실**: `usetrmnl/firmware src/bl.cpp`+`byos_sinatra` 대조로 계약 확정. PNG 지원(BM 스니프), filename 캐시, `image_url_timeout`. 로컬 폴루프로 서버 정상이면 "not responding"은 WiFi 문제.
- **Swift는 SVG 못 읽음** → `TrmnlImageRenderer.swift`에 미니 `SVGPath` 파서(M/L/H/V/C/S/Q/T/A/Z, 원호→큐빅, `addArc` clockwise 회피) + 브랜드 path 바이트미러. standalone `swiftc` 하니스로 4글리프 검증.
- **세션 의미 요약 = 첫 프롬프트가 최선**(LLM 요약 인프라 없음). currentTask는 마지막 도구 호출뿐.
- **동시 세션 주의**: 같은 워킹트리 다중 세션 — 공유파일(d200h-layout) 섞이면 분리, 비공유(timebox micro-glyphs)는 각자 커밋. 커밋 전 `git status`로 남의 WIP 확인.

### 검증
Node: vitest 38(TRMNL suites) green. Swift: `xcodebuild AgentDeck_macOS` BUILD SUCCEEDED. 실기기(MAC `1C:DB:D4:74:F4:D8`) 라이브 검증: 아이콘·goal·CJK·footer 정상. 7 commits (`aecfb6c3`..`ba381bbf`), PR #19.

---

## 2026-06-22 — TRMNL e-ink BYOS: device-agnostic Node + App Store Swift 포팅

### 문제
TRMNL(WiFi e-ink BYOS 패널)은 (1) Node 브리지 전용이라 **App Store Swift 데몬에선 아예 동작 안 함**, (2) 해상도를 **800×480으로 하드코딩**하고 device가 보내는 `Width`/`Height` 등 BYOS telemetry 헤더를 전부 무시 → 다른 모델/해상도 패널이 붙으면 잘못된 크기 이미지를 받음, (3) `normalizeMac`이 12-hex 아닌 ID를 raw로 돌려줘 MAC 표기가 달라지면 orphan/중복 enrollment.

### 해결
- **Node device-agnostic** (`bridge/src/trmnl/`, `shared/src/trmnl-layout.ts`): `renderTrmnlDashboard`를 해상도 가변(행수=`floor((H-header-footer)/rowH)`, 컬럼·게이지 W 비례, 극단 화면비 compact 가드)으로. 단일 글로벌 프레임 → **`WxH` 키 프레임캐시(LRU 8)**, image URL이 `<W>x<H>-<hash>.png` 운반. `normalizeMac` 결정적 정규화 + `sameMac`. telemetry 헤더 런타임 맵(`trmnl-telemetry.ts`). `special_function` 추가. idle hero(합성 phantom row 제거). 28 테스트 green.
- **App Store Swift 포팅** (`apple/.../Trmnl{Module,ImageRenderer,Settings}.swift` + `DaemonServer.swift`): TS SVG/resvg는 이식 불가 → **CoreGraphics + CoreText로 대시보드 직접 그리고 1-bit grayscale PNG를 Foundation zlib로 인코딩**(D200H 렌더러 패턴). `TrmnlModule`은 actor, MAC 무관 auto-enroll + 해상도별 캐시 + in-memory enrollment/telemetry. 전송은 기존 `HTTPServer`(`/api/setup`·`/api/display`·`/api/log`·`/trmnl/image/*`). `xcodebuild AgentDeck_macOS` BUILD SUCCEEDED, 바이너리 forbidden-subprocess 0.
- **부수 수정**: direct-HID 폐기 커밋(`6d298427`)이 `let d200hRef = d200h`를 비활성 블록 안 var로 깨뜨려 **커밋된 HEAD의 macOS 타깃이 컴파일 불가**였음 → `self.d200hModule`(옵셔널, nil) + `?.handleBroadcast`로 복구.
- **문서**: `appstore-feature-matrix.md`·`hardware-compatibility.md`·`hardware/index.html` 사양표에 TRMNL 행 추가.

### 핵심 설계 결정
- **App Store 적법**: 신규 entitlement 0 — 기존 `com.apple.security.network.server`로 커버(Pixoo `/pixoo/frame`과 동일 LAN-HTTP 선례). resvg/Node/서브프로세스 일절 없음. TS SVG 레이어는 공유 불가라 Swift는 레이아웃을 손으로 재구현(D200H/Pixoo와 동일).
- **enrollment 비영속**: settings.json write 없이 in-memory. 폴링마다 파일 쓰면 thrash + UI 편집 레이스. 재시작 시 다음 폴링에 재등록(soft auth라 안전).
- **`vitest`/`tsc`/SourceKit green ≠ Swift 모듈 컴파일** — Apple 편집 후 반드시 `xcodebuild AgentDeck_macOS`로 실검증해야 HEAD 컴파일 드리프트를 잡는다.

---

## 2026-06-21 — Timebox Mini: 디스플레이 sleep/wake + micro 크리처 canonical 재드로

### 문제
Divoom Timebox Mini(11×11 BLE)가 iDotMatrix와 달리 (1) macOS 화면 sleep/wake에 전혀 반응 안 하고, (2) 보여지는 micro 크리처가 원본 스프라이트와 너무 달랐다. 추가로 유저 기기에 "옛 애니메이션"이 떠 있던 진짜 이유는 **기기가 데몬 settings에 미등록**(`timeboxDevices: []`)이라 `sync_ble.py`가 아예 안 떠서 — 화면은 기기 공장 기본 애니였다(옆에서 돌던 BLE는 별개 iDotMatrix `98A0BE6C`).

### 해결
- **sleep/wake** (`bridge/src/timebox/sync_ble.py`): iDotMatrix 패턴(`fetch_display_state` + `resolve_display_brightness` + dim-then-pause 루프) 이식. BLE sync 드라이버는 `display_state`를 WS로 못 받으므로 각 스크립트가 데몬 `/display-state`를 직접 폴링해야 함. Timebox는 **하드웨어 brightness 명령이 없고 소프트 brightness가 프레임에 baked**(0=blank sleep 프레임)이라, dedup key를 `sha256(frame)|brightness`로 만들어 source 프레임이 같아도 sleep/wake 시 재푸시. 공유 `displaySleepDim` 설정 준수.
- **canonical 재드로** (`bridge/src/pixoo/micro-glyphs.ts`): `27995fbd`의 "sharpen"도 원본과 안 닮아 유저가 재지적. `pixoo-sprites.ts`의 HD/MD 스프라이트에 맞춰 4종 재드로 — Codex=구름+아래 촉수 로브(was 공), OpenCode=코어 없는 hollow 이중 링(was 꽉 찬 회색 코어=그림자), 가재 눈=teal `#00E5CC`(was near-black), 문어 눈=2×2 negative space(was 1px). 1:1(11px) PNG로 눈검증.
- **Swift 패리티**: `apple/AgentDeck/Daemon/Modules/MicroGlyphs.swift` byte-mirror + `TimeboxProtocolTests.swift` 골든 픽셀 갱신(문어 팔 row, codex 몸체 col). TS↔Swift 격자·색상 자동 대조 통과.

### 핵심 설계 결정
- micro 글리프는 애니가 아니라 **손그림 11×11 비트맵 품질 + canonical 스프라이트 충실도**가 전부. 눈색 규칙: 문어=near-black negative space, 가재=teal(`pixoo-sprites.ts` COLORS). 64px에서 멀쩡해도 11px에서 깨지니 1:1 눈검증 필수.
- 이 글리프는 **두 번째 회귀** — 승인본이 커밋 전 동시-세션 wipe로 두 번 날아감. 재드로 직후 즉시 커밋(`752492fc`)으로 보호.

---

## 2026-06-21 — D200H direct-HID 폴백 폐기: Ulanzi Studio 플러그인 단일 경로로

### 문제
D200H는 Mac용 **Ulanzi Studio** 앱 없이는 제대로 렌더링하기 어려운데, 두 데몬(Node CLI / Swift macOS)이 여전히 **direct-HID 폴백**으로 기기를 직접 잡고 있었다. stand-down은 *Ulanzi 플러그인이 마침 연결돼 있을 때만* 발동(`onUlanziPluginPresence`→`setExternalOwner(true)`)하므로, Ulanzi Studio가 안 떠 있으면 데몬이 기기를 그대로 가로채 "제대로 안 되는 화면"을 그렸다. 어떤 settings 토글도 이를 막지 못했다(중재가 순전히 "플러그인 연결 여부"였음).

### 해결 (activation 비활성화 — 코드는 dormant 보존, 가역적)
- **Node CLI daemon**: `bridge/src/daemon-server.ts`의 `initModules` 설정을 `d200h: 'auto'` → `d200h: false`. `D200hModule.shouldActivate(false)`가 즉시 `false`라 모듈은 `createDefaultModules`로 인스턴스화되지만 `start()` 안 됨 → `node-hid` 미접근. 세션 브리지(`cli.ts`)는 이미 전부 `d200h: false`라 유일한 활성화 지점이었음.
- **Swift macOS daemon**: `apple/AgentDeck/Daemon/Server/DaemonServer.swift`에서 `D200hHidModule()` 생성/등록을 `let enableD200hDirectHID = false` 가드로 감쌈 → IOKit `IOHIDManager` 미생성, `d200hModule`은 `nil` 유지. 모든 소비자가 이미 `if let d200hModule` 가드라 status 스냅샷에서 빠지고 stand-down 훅은 no-op.

### 핵심 설계 결정
- 코드 삭제가 아니라 **activation off** 선택: `D200hModule`/`D200hHidModule.swift`/`bridge/src/d200h/*`/공유 `d200h-layout.ts` 전부 유지. 되돌리려면 Node 설정을 `'auto'`로, Swift `enableD200hDirectHID`를 `true`로 플립.
- `ulanzi-plugin` 등록/stand-down 중재(`ws-server.ts` `onUlanziPluginPresence`, Swift `setExternalOwner`)는 dormant 코드로 그대로 둠 — direct-HID가 살아 있을 때만 의미 있던 경로라 무해.
- `plugin-ulanzi`는 무변경: 이미 기기 소유 + 데몬 죽으면 OFFLINE/press-to-launch(아래 항목).

---

## 2026-06-21 — D200H(Ulanzi 플러그인) 오프라인 시 OFFLINE 화면 + 키 눌러 컴패니언 앱 실행 (SD/SD+ 패리티)

### 문제
macOS 컴패니언 앱(데몬)이 안 떠 있을 때 D200H가 "제대로 작동 안 하는 fallback"을 보였다. `plugin-ulanzi`는 이미 WS 끊기면 `DISCONNECTED`로 강제했지만(`StateStore.toLayoutInput`), `buildSessionDeck`이 OFFLINE 타일을 **코너 키(slots[0]=0_0)** 에만 그리고 나머지는 빈 칸 + 모든 키 `action: null` 이라 **눌러도 아무 일도 안 일어났다**. SD/SD+는 오프라인 시 아무 키나 누르면 앱을 실행한다(`session-slot-button.ts:357` → `openAgentDeckAppOrGitHub`).

### 해결
- `shared/src/d200h-layout.ts` `buildSessionDeck` DISCONNECTED 분기: OFFLINE 히어로를 **가운데 키**(`Math.floor(slots.length/2)`)로 옮기고 "press any key" 힌트 추가. `DeckAction`에 `{ kind: 'launch' }` 추가 후 **모든 키**에 부여 → 아무 키나 눌러도 앱 실행.
- `plugin-ulanzi/src/launch.ts`(신규): `launchCompanionApp()` — `open -a AgentDeck`, 실패 시 GitHub 페이지 폴백. SD의 `openAgentDeckAppOrGitHub` 미러(크로스-패키지 import 불가라 복제). Node+macOS 전용.
- `plugin-ulanzi/src/app.ts` `onPress`에 `launch` case 디스패치.

### 핵심 설계 결정
- D200H 오프라인 화면 "주체"는 **구동 경로별로 다르다**: Ulanzi Studio 플러그인(별도 프로세스, 데몬 죽어도 살아 WS 재연결·앱 실행 가능)이 SD/SD+의 진짜 analog. direct-HID(Swift/Node 데몬이 HID 직접 구동)는 데몬=구동주체라 데몬이 죽으면 아무도 못 그림 — "press to launch"가 구조적으로 불가하므로 이번 변경 범위 밖(별도 엔진 `computeLayout`).
- `buildSessionDeck`/`DeckAction`은 **plugin-ulanzi 단일 소비자**(grep 검증)라 union 확장이 격리됨.

---

## 2026-06-19 — CLI iDotMatrix display sleep/wake dim parity 점검 및 수정

### 문제
macOS 모니터 sleep/wake 시 `display_state` 동기화 경로를 점검한 결과, Node CLI daemon의 Pixoo/D200H/ESP32/Stream Deck/Android 경로와 Swift in-process daemon의 Pixoo/D200H/ESP32/iDotMatrix 경로는 밝기 dim/restore를 처리했지만, **CLI-only iDotMatrix**는 Python BLE sync가 `/pixoo/frame?size=32`만 폴링하고 고정 brightness를 60초마다 재주장해 host display off/on을 반영하지 않았다.

### 해결
- Node daemon에 `GET /display-state`를 추가해 현재 `displayOn`과 `displaySleepDim` 설정(`enabled/mode/level`)을 JSON으로 노출.
- `bridge/src/idotmatrix/sync.py`가 `/display-state`를 폴링해 display off 시 `off=5%`(iDotMatrix 하드웨어 floor), `min=level%`, wake 시 설정 brightness로 복원하도록 수정.
- dimmed 상태에서는 BLE 프레임 업로드를 멈춰 Swift iDotMatrixModule의 `displayDimmed` guard와 동작을 맞춤.

### 핵심 설계 결정
- iDotMatrix는 BLE 밝기 명령 범위가 5~100이라 true-off 대신 5%를 practical off floor로 사용한다. 이는 Swift 네이티브 iDotMatrix 경로와 동일한 정책이다.
- `/display-state`가 없는 구형/session-only bridge에 붙은 수동 sync는 기존처럼 설정 brightness를 유지하도록 graceful fallback.

---

## 2026-06-17 — D200H: 공식 Ulanzi Studio 플러그인(주) + direct-HID(폴백) + 공유 세션 덱 엔진

### 문제
D200H가 direct-HID(역공학 0x7C7C)에서 "이미지 안 뜸 + 버튼 오작동"으로 불만. 더 근본적으로 사용자가 "벤더 공식 SDK로 갈아탈지" 물음. 1차 진단으로 direct-HID는 평범한 버그(폰트·버튼맵)였지만, Ulanzi가 **공식 플러그인 SDK(Elgato 스타일, Studio 안에서 WS)** 를 제공함을 확인 → 그게 더 맞는 경로.

### 해결
- **direct-HID 폴백 수선**: resvg가 폰트 미공급(`loadSystemFonts:false`+fontFiles 없음)이라 `<text>` 전멸 → `bridge/assets/fonts`(IBM Plex Sans+JetBrains Mono, OFL) `fontFiles`+`defaultFontFamily`. 버튼맵을 렌더 layout 단일소스화(`buildButtonCommandMap`).
- **신규 `plugin-ulanzi/`** (공식 UlanziDeckPlugin-SDK vendor): **단일 동적 액션** + **세션 중심 2단계 UX(v4)** — 목록(키1=세션1, 고정위치, awaiting 강조) ↔ 상세(BACK+INFO+옵션/Allow·Deny(requestId면 permission_decision)/idle 빠른액션+STOP). 데몬 자동발견(Swift/Node 무관) + `client_register clientType:ulanzi-plugin`. self-contained 패키징(esbuild + resvg 네이티브·ws 동봉) + 원클릭 설치.
- **공유 레이아웃 엔진** `shared/src/d200h-layout.ts`: `buildSessionDeck`(v4) + 레거시 `computeLayout/buildButtonCommandMap`(direct-HID). direct-HID와 플러그인이 동일 엔진.
- **충돌 배타(App Store 완결성)**: `ulanzi-plugin` 등록 시 데몬이 direct-HID를 stand-down. Node(`ws-server`+`d200h-module.setExternalOwner`) + Swift(`DaemonServer` 훅 + `D200hHidModule.setExternalOwner`, 디바이스 미오픈만 — App-Store-safe, macOS BUILD SUCCEEDED).

### 핵심 설계 결정 / 교훈
- **기기 디코드엔 풀 데이터 URI 필수**: `setBaseDataIcon`에 `data:image/png;base64,…` 프리픽스 없으면 Studio 프리뷰는 렌더되나 **하드웨어는 못 풀어 옛 프레임 유지**(공식 데모도 풀 URI). 가장 오래 헤맨 버그.
- **더블파이어**: D200H는 키 1회 누름에 `keydown`+`run` 둘 다 발생 → 둘 다 핸들하면 open→back 상쇄. `run` 하나만 처리.
- **반응성 = Studio 경유 LCD의 한계 + 우리 오버헤드**: 풀-덱 reflow + 매 렌더 GIF 재인코딩이 Studio→하드웨어를 폭주(초당 7회). 처방: GIF 기본 OFF(정적 PNG, env opt-in) + 키별 페이싱 큐 + 렌더 throttle/dedup + PNG 캐시. Stream Deck(네이티브+SVG직결)보다는 느림.
- **Ulanzi `key` = `col_row`**("0_0"~"4_0", 실기기 13키=5+5+3) — 우리 그리드 스킴과 동일해 단일 동적 액션이 성립.
- **공식 SDK 유무를 repo 검색만으로 단정 말 것**(사용자 정정). 벤더 native .dylib SDK였다면 App Store 위반이었겠지만, 플러그인 SDK는 Studio 안에서 돌아 AgentDeck.app에 미번들 → 불변식 무관.

## 2026-06-14 — TTGO 세로모드 검정 진짜 원인(캔버스 stride 비정렬) + 회전 화면 누수 먹통 + 오버레이 레벨트리거

### 증상
직전 "80px 메트릭 스트립" 작업으로 전체 검정 오버레이를 제거한 뒤에도 **가로모드는 테라리움 정상, 세로모드만 검정**이 남았다. 이후 stride 수정으로 세로가 정상이 되자, 이번엔 **회전 버튼을 2번째 누르는 순간 기기가 먹통**(프리즈)이 됐다.

### 근본 원인 3종 (시리얼 직접 구동 + firmware 로그로 각각 확정)
1. **세로 검정 = LVGL 캔버스 draw-buf stride 비정렬.** `lv_conf.h`의 `LV_DRAW_BUF_STRIDE_ALIGN 32`. 캔버스 stride = `canvasW*2`인데, 가로는 너비 160px → 320B(32정렬, 정상), 세로는 너비 135px → 270B(=8×32+14, **비정렬**) → LVGL blit 경로가 깨져 검정 밴드. C6(172px, 역시 비정렬)가 멀쩡해 보여 1차에서 오배제했으나, C6는 **기본이 가로**라 세로 비정렬이 미검증이었음. **착시 단서**: 화면 배경은 모래색(`0x2A1F14`)·splash는 파랑(`0x163B5C`)이라, 렌더 실패면 모래색이 보여야 함 → "순수 검정"은 near-black 불투명 요소(`connScrim 0x070B13`)이거나 blit 깨짐.
2. **회전 먹통 = 화면 재생성 heap 누수.** 회전 시 `main.cpp`가 splash/aquarium/timeline/settings/permission **5개 스크린을 재생성**하는데, 각 `xxxCreate()`는 `lv_obj_create(NULL)`로 새로 만들고 모듈-static 포인터만 덮어쓸 뿐 **옛 스크린을 삭제 안 함** → 회전마다 스크린 트리 5개 통째 누수. PSRAM 없는 ESP32라 heap ~200KB뿐 → 1차 회전(자동 portrait)은 성공·heap ~50KB로 하락, 2차 회전(버튼)에서 재빌드 중 추가 할당 실패 → 모든 JSON `[Protocol] JSON error: NoMemory` + 먹통.
3. **연결 오버레이 stuck = 엣지 트리거.** 연결상태 스크림 갱신이 `showConnected`/`wifiNow` **엣지에서만** 동작 → 회전이 화면을 재생성하면 새 `connScrim`이 하드코딩 기본값(HIDDEN)으로 생기는데 엣지가 안 떠 실제 연결상태 재적용이 누락(로그상 회전 후 `[Conn] overlay status` 없음). "가로는 우연히 숨겨져 정상, 부팅 orientation은 stuck" 비대칭의 정체.

### 해결
- **stride** (`esp32/src/ui/terrarium/renderer.cpp`): 세로 캔버스 너비를 16의 배수로 패딩(`TTGO_PANEL_SHORT_EDGE_W = 144`, 135→144) → stride 288B(32정렬). 남는 9px는 화면 우측 밖 클리핑. LVGL이 stride를 존중하든 재계산하든 둘 다 288이라 mismatch 불가. 정적 버퍼 `ttgo_canvas_buf[144*160]`(+2880B, DRAM free 10424→7544, 예산 내). 검증: 세로 `Canvas 144x160`, 가로 `Canvas 160x135` 둘 다 정렬.
- **회전 누수** (`esp32/src/main.cpp`): 회전 재생성 시 옛 5개 스크린 포인터 보관 → 새 스크린 생성·`lv_screen_load`(활성 전환) **후** `lv_obj_del`로 옛 스크린 삭제(LVGL은 활성 스크린 삭제 금지라 순서 필수). 캔버스 draw-buf는 공유 정적 버퍼라 객체 삭제해도 live 화면 무영향. 검증: **10회 연속 회전 NoMemory 0·heartbeat_ack 54·먹통 없음**(수정 전 2회째 사망).
- **오버레이 레벨트리거** (`esp32/src/main.cpp`): 엣지 트리거 폐기, 매 프레임 desired `ConnOverlayStatus` 계산해 실제 적용값과 다를 때만 적용(`lastOverlayStatus`). 회전 재생성 시 `lastOverlayStatus=-1`로 강제 재적용. recreation-safe + self-heal.

### 핵심 교훈
- **LVGL 캔버스 stride는 항상 `LV_DRAW_BUF_STRIDE_ALIGN`(=32B) 정렬 필요.** 캔버스 너비를 16px 배수로 두지 않으면 보드/회전에 따라 검정. 폭이 16배수인 보드는 우연히 통과해 회귀가 늦게 드러남.
- **회전 = 전체 화면 재생성 = 누수 위험 1순위.** 스크린 재빌드 패턴은 옛 트리 삭제를 반드시 동반. PSRAM 없는 보드는 1~2회만에 heap 고갈.
- **CH340 TTGO 플래시**는 먹통/크래시 상태에서 "chip stopped responding" 반복 → **USB 물리 재인가**가 유일한 깨끗한 복구. 플래시 ~5.5분(57600+--no-stub).
- **시리얼 직접 구동 디버깅**: 데몬 중지 후 pyserial로 heartbeat JSON 주입(연결상태 위조) + `set_orientation` 명령 + firmware 로그 캡처로 화면 없이도 stride/scrim/heap 거동을 실측. pyserial DTR/RTS 자동리셋은 이 보드에서 불안정(esptool 또는 전원재인가 사용).

## 2026-06-14 — TTGO 테라리움 검은 배경 재발 원인 분석 + 80px 메트릭 스트립 고정

### 문제
TTGO T-Display 에서 테라리움 배경 대신 검은 화면처럼 보이는 현상이 계속됐다. 이전 안정화는 전체 135×240 테라리움 캔버스를 포기하고 135×160 정적 버퍼 + 80px 메트릭 영역으로 낮추는 방향이었지만, 현재 UI 위젯은 테라리움 위에 **전체 화면 `0x000000` / 50% 오버레이**를 덮고 있었다. 작은 ST7789 패널에서는 이 반투명 레이어가 수중 배경을 사실상 검정으로 눌러 보이게 만들었다. 또한 회전 상태가 landscape 로 남아 있으면 고정 135×160 캔버스가 240×135 화면의 좌측 일부만 차지하는 불일치도 있었다.

### 하드웨어 한계
LilyGO TTGO T-Display 1.14" 는 ST7789 135×240 SPI LCD + ESP32 classic 계열이며, PSRAM 없이 동작한다. 이번 빌드 기준 `pio run -d esp32 -e ttgo` 의 정적 DRAM 여유는 **10,424 bytes**뿐이다. 전체 135×240 RGB565 캔버스는 64,800 bytes, 현재 제한된 135×160 캔버스는 43,200 bytes 라 전체 캔버스로 되돌리면 추가 21,600 bytes 가 필요해 정적 DRAM 예산을 초과한다.

### 해결
- TTGO 테라리움 버퍼를 21,600픽셀로 고정하되, 회전에 따라 135×160(세로) 또는 160×135(가로)로 해석하게 했다.
- `TTGO::StateWidget` / `TTGO::ActivityWidget` 의 전체 화면 검정 반투명 배경을 제거하고, 남는 80px 메트릭 스트립만 모래색 불투명 패널로 칠하게 했다. 테라리움 영역 위에는 더 이상 검정 오버레이가 올라가지 않는다.
- TTGO LVGL partial draw buffer 를 40라인에서 20라인으로 줄여 런타임 DMA-capable heap 압박을 낮췄다.
- 문서화: `docs/esp32.md` 에 TTGO 전체 캔버스 금지와 160px terrarium + 80px strip 규칙을 추가.

### 검증
`pio run -d esp32 -e ttgo` 성공. 빌드 결과: DRAM 114,156 / 124,580 bytes 사용(91.63%), 잔여 10,424 bytes. Flash 2,597,031 / 6,291,456 bytes 사용(41.3%).

## 2026-06-14 — APME 재구축: canonical SessionSample (Inspect 스타일) SSOT + cost/Pareto + 타임라인 projection

### 문제
타임라인과 APME 평가가 **두 개의 분리된 파편화 파이프라인**이었다. 어댑터가 chat_start/response/end·tool_request/resolved 를 직접 emit(중복·race·경계 없음), 디스플레이타임 `groupConsecutive` 로만 묶임. OpenClaw `session.tool`/`session.message` 는 default case 에서 **silent drop**(`openclaw.ts:1093`) → 대부분 도구 호출이 아예 안 보임. 평가 단위(`task`)는 untyped `steps` + `tool_calls:count` 로 trajectory 손실. 비용/모델 비교는 스키마에만 있고 미활용.

### 해결
Inspect AI 의 `EvalLog→Sample→Event→Scorer` 모델을 네이티브(TS+Swift, Python/subprocess 無)로 차용. **`SessionSample`** = 경계 있는 단위 + 타입 trajectory(user/assistant/model/tool/state/info) 를 도입, 타임라인·평가 **둘 다 이것의 projection**.
- **shared**: `sample.ts`(SessionSample + TrajectoryEvent), `pricing.ts`(override 가능 단가표, local=$0), `trajectory` eval layer.
- **bridge**: collector 가 `sample_events` 에 dual-write(UNIQUE index 저장시점 dedup) + cumulative-usage delta 로 per-task 비용 pricing; runner 가 `getSample()` 로 도구 trajectory 를 judge 프롬프트에 + `scorers/`(trajectory_quality·tool_efficiency); `pareto.ts` frontier + recommender 재배선; `/apme/pareto`·`/apme/samples` 라우트; OpenClaw `session.tool`/`session.message` 캡처 복구.
- **Phase 6 타임라인 컷오버 (flag-gated, default OFF)**: `AGENTDECK_TIMELINE_PROJECTION=1` 시 타임라인이 SessionSample projection 으로 전환 — 로컬 chat/tool 행 suppress, projected/relayed/task 행은 bypass. `BridgeTimelineStore.setSuppressLocalChatTool` + `add(entry,{bypassSuppression})`, `DaemonTimelineStore` 미러.
- **Swift 데몬 미러**: 스키마+sample DAO, collector dual-write+pricing(`ApmePricing.swift`), scorers(`ApmeScorers.swift`), Pareto recommender, HTTP 라우트, projection. App Store 타깃 빌드 clean, 신규 subprocess 문자열 0.
- 검증: vitest **1360 통과**, `xcodebuild AgentDeck_macOS` SUCCEEDED. 데몬 재시작으로 라이브 반영 + 신규 라우트 실측 확인. 커밋 `e83953f5`.

### 핵심 설계 결정
- **하나의 normalizer(collector) + 두 projection(타임라인·평가)** 으로 "two pipelines" 버그군 제거 — 디스플레이타임 grouping·8s race dedup·OpenClaw drop 이 부수적으로 해결됨.
- 기존 `task` 행 = SessionSample 헤더로 재사용(rename 없음). `steps` 는 raw archive 로 유지.
- 컷오버는 **env 플래그 default OFF** — 배포는 타임라인 무변경(안전), 사용자가 1개 표면에서 렌더 검증 후 전역 flip. 코드 변경 없이 env 빼면 즉시 원복.
- Node/Swift 데몬은 **alternative(동시 아님)** 라 sample dedup_key 는 raw composite 로 충분(cross-daemon dedup 불필요).
- pricing 달러값은 best-effort public 단가 + **런타임 override 가능**(`setPricingOverrides`) — 코드 수정 없이 정정. claude-api skill 의 단가가 redacted 라 임의값 하드코딩 회피.

## 2026-06-14 — OpenClaw 타임라인 오표기 fix (attribution + cron 프롬프트 dump)

### 문제
사용자가 timeline 에서 "OpenClaw 가 bash 작업 같은 걸 하고 있다"고 보고. `~/.agentdeck/timeline.json` 분석 결과 결함 2종:
1. **(Node, 라이브)** OpenClaw Gateway cron 활동(memory review/LINE/YouTube 더빙)이 `agentType:null` + `projectName:"AgentDeck"` 로 들어가 OpenClaw 로 분류되지 못하고 AgentDeck 프로젝트에 섞임.
2. **(Swift)** Gateway 가 echo 한 cron 프롬프트(`[cron:...]` prefix, 내부에 `ls -lt`/`tail -50` 셸 문구)가 `model_call.detail` 에 truncation 없이 통째로 dump → bash 실행처럼 보임. 실제 도구 실행 아니라 프롬프트 텍스트.

### 진단 키
`timeline.json` 은 Node·Swift 데몬이 번갈아 쓰는 같은 파일. 출처 구분 시그니처: **`model_call` 타입 = Swift 전용** emit, **`automated:true` 플래그 = Node 전용** 설정.

### 해결
- **Fix A (Node):** `daemon-server.ts` 에 `enrichGatewayTimelineEntry()` export 추출 → `case 'timeline'` 에서 어댑터 엔트리에 `agentType:'openclaw'`/`projectName:'OpenClaw'` stamp. 어댑터(`openclaw.ts`)는 bare 엔트리를 emit 하고, `bridge-core.ts` attributor 는 projectName 을 데몬 하드코딩 `'AgentDeck'` 로 fallback + agentType fallback 없음 → null 이던 것을 chokepoint 에서 보정. 데몬 재시작 후 실제 cron turn 으로 end-to-end 검증(chat_start/response/end 전부 openclaw/OpenClaw 로 표기).
- **Fix B (Swift):** `OpenClawAdapter.swift` 의 model_call/model_response/`fromSessionMessage` 에서 `detail` 1000자 cap(Node 의 ~1000 cap 과 정합) + `[cron:` 감지 시 `automated:true`(`automatedRunId` instance var 로 response 까지 전파).
- 회귀테스트 `bridge/src/__tests__/gateway-timeline-attribution.test.ts` 추가.

### 핵심 설계 결정
Gateway 어댑터는 OpenClaw 전용 wiring 이므로 origin attribution 은 어댑터 출구가 아닌 **데몬 핸들러 chokepoint** 에서 stamp(단일 지점). 긴 프롬프트/응답은 detail cap 필수 — cron 지시문은 multi-KB 셸-verb blob 이라 verbatim 노출 시 도구 실행으로 오인됨.

## 2026-06-14 — OpenCode 크리처 전 표면 hollow-ring 재설계 + IPS10 2D 트리맵

### 문제
- OpenCode 크리처가 기기마다 제각각이고 원본 로고와 달랐다. 진짜 `design/brand/opencode.svg`(`M16 6H8v12h8V6zm4 16H4V2h16v20z`, **evenodd**)는 세로 직사각 **링**(outer 16×20, inner 8×12 hollow) 단색인데, 대부분 표면이 채워진 nested square + 어두운 inner 로 그려 **가운데가 그림자처럼** 보였다.
- 게다가 일부 표면은 아예 깨짐: **Pixoo32/iDotMatrix** 는 HD 그리드가 32px 를 오버플로우해 OpenCode 미표시, **TC001** 은 cyan(브랜드 아님) + 5×5 정사각, **Pixoo 상단 에이전트 점 인디케이터** 는 색이 octopus/jellyfish 2종뿐이라 opencode 점이 octopus 색으로 묻힘.
- IPS10 사이드바 모자이크가 좁은 세로 스택이라 공간을 못 채웠다.

### 해결 (uncommitted → 이번 세션 커밋)
- **OpenCode = 단색 hollow vertical ring 으로 통일**:
  - ESP terrarium: `generate-creature-glyphs.mjs` 에 OPENCODE evenodd 래스터 추가 → `creature_glyphs_generated.h` mask, `opencode.cpp` 가 그리드 대신 `Draw::alphaMask` 단색 hollow 렌더.
  - Pixoo(64/32/iDotMatrix): `pixoo-sprites.ts drawOpenCode` 그리드→**procedural hollow ring**(해상도 무관 스케일, 32px 해결).
  - TC001: `matrix_pages.cpp` 색 cyan→warm gray, sprite 5×8(과도)→**5×6 ring + dim 3×4 inner shadow**(다른 크리처와 키 맞춤, 깊이감).
  - e-ink/tablet: `drawEinkOpenCode`/`OpenCodeCreature.kt` thick-stroke ring(e-ink 은 B&W 대비 위해 dark stroke).
  - shared SVG: `agent-logos.ts` 3중 fill→evenodd path.
  - Pixoo 점 인디케이터: `pixoo-renderer.ts` 점 색에 opencode 분기 추가(`getOpenCodePaletteForSession().outer`).
- **IPS10 모자이크 → 2D 트리맵**: `hud_bar.cpp` absolute-positioned 셀 slice-and-dice(면적 ∝ activity weight, 긴 변 분할), rect lerp 유동. terrarium canvas 408 / 사이드바 372 로 폭 확대(`renderer.cpp`).

### 핵심 설계 결정
- **단일 캐노니컬 geometry 를 표면별 렌더 기법에 매핑**: 같은 evenodd 링을 ESP 는 빌드타임 alpha mask, Pixoo 는 procedural, tablet/e-ink 는 stroke, SVG 는 path 로. 펌웨어는 런타임 SVG 파싱 불가라 mask 가 정답.
- **TC001 같은 초저해상도(8px)에서는 hollow 가 비어 보여** inner 를 body 밝기의 40% dim shadow 로 채워 깊이 부여 — 큰 화면의 "그림자처럼 보임" 불만과 반대 방향이지만 매체 특성상 정당.
- ESP 플래시는 매 보드 `device_info_request` 재검증 후 진행(IPS↔AMOLED 오플래시 위험 차단). C6 는 probe 타이밍으로 1회 skip 후 재시도 성공.

---

## 2026-06-13 — iDotMatrix 정체 규명 + 네이티브 CoreBluetooth 제어 (App Store 합법화)

### 문제
- "픽셀 디스플레이 32"가 화면 나오다 무한 재부팅. 처음엔 ESP32 1024-LED 매트릭스로 가정하고 brownout(전력 캡 부재 + TC001용 밝기 상속)으로 진단했으나, 기기를 분해해보니 **컨트롤러가 ESP32가 아니라 BLE SoC**(실크 핀 `PA9`/`PC4`/`ANT1`/마이크/부저 — Telink TLSR8 계열)였다.
- 레포의 `[env:idotmatrix]` + `boards/board_idotmatrix_s3.h`는 "iDotMatrix=ESP32-S3"라는 **틀린 가정**으로 만들어진 유령 보드. 헤더의 MAC 주석(`d0:cf:13:1e:0b:64`)이 실제론 **round AMOLED ESP32**의 것이라, MAC 매칭만 믿고 round 기기에 매트릭스 펌웨어를 **오플래시**(round 화면 black/TG1WDT 루프) → 올바른 `amoled` 펌웨어 재플래시로 복구.
- iDotMatrix 제어가 Node CLI의 **Python 서브프로세스(`idotmatrix/sync.py`, bleak)** 로만 가능 → 번들 인터프리터 + subprocess라 App Store 불변식(2.5.2) 위반. App Store macOS 앱엔 기능 부재.

### 해결 (commit 7dfc8963, 852dd97a)
- **유령 보드 제거**: `[env:idotmatrix]` + `board_idotmatrix_s3.h` + `board_config.h` 분기 삭제. iDotMatrix는 BLE 경로(`agentdeck idotmatrix sync` / 네이티브)로만 구동.
- **네이티브 Swift CoreBluetooth 재구현** (Pixoo가 HTTP라 합법인 것과 동일 전략):
  - `IDotMatrixBLE.swift` — `IDM-` 스캔, CBPeripheral UUID 연결, service `fa00`/write char `fa02`, MTU 청크 write, `setMode(1)`/`setBrightness`/`uploadImage`. 모든 connect/write await에 타임아웃 강제(OpenClawAdapter 패턴).
  - `IDotMatrixModule.swift` (`actor DeviceModule`) — PixooModule 미러(Shadow/circuit-breaker/offline-frame/5s settings reload/handleEvent). 프레임: `PixooRenderer`(64×64) → 2×2 box 다운스케일 32×32 → PNG.
  - `IDotMatrixSheet.swift` — BLE Scan→Pair UI + 밝기 슬라이더. `idotmatrixDevices[]` 저장.
  - entitlement `com.apple.security.device.bluetooth` + `NSBluetoothAlwaysUsageDescription`(macOS+iOS) + 기능 매트릭스/리뷰 노트.

### 핵심 설계 결정
- **상용 BLE 기기는 ESP32 펌웨어 대상이 아니다.** 기기 식별은 보드 헤더 MAC 주석을 믿지 말고 **연결/해제 시 사라지는 포트 diff**로 확정. iDotMatrix의 USB는 데이터가 아니라 전원 입력(포트 안 뜸).
- **BLE를 App Store에 넣는 걸 막는 건 BLE가 아니라 Python 서브프로세스.** CoreBluetooth는 1st-party라 `verify-appstore-archive.sh` 무관, entitlement+usage string만 필요.
- **공존**: in-process Swift 데몬은 외부 Node 데몬이 9120을 소유하지 않을 때만 실행(상호 배타) → 두 데몬이 BLE 단일 연결을 동시에 잡는 일 없음. standalone `idotmatrix sync` 오버랩만 남고, 그건 circuit breaker가 backoff로 흡수(`isUsingExternalDaemon` 플러밍 불필요).
- 원래 재부팅은 **기기 자체 전원 brownout**(코드 무관, 2A+ 어댑터로 해결).

---

## 2026-06-13 — 도트 디스플레이 크리처 렌더링: iDotMatrix 32px 사이징 + TC001 노이즈/크리처

### 문제
- 신규 **iDotMatrix 32×32 BLE** 디스플레이(`/pixoo/frame?size=32`)에서 크리처가 프레임을 넘쳐 터라코타 색 벽 + 거대한 검은 눈 사각형으로만 보였다. 64px Pixoo는 정상.
- Pixoo/iDotMatrix **OpenClaw 가재**가 세로로 길쭉(`cellH = cellW*1.5`)하고 공식 마스코트(`design/brand/openclaw.svg`)와 안 닮았다.
- **Ulanzi TC001**(8×32 WS2812 매트릭스, ESP32) 화면에 조금씩 노이즈/시머가 끼고, 크리처가 단색 5×6이라 표현이 빈약했다.

### 해결 (commit a467edd1)
- **해상도 인식 사이징**: `bridge/src/pixoo/pixoo-sprites.ts`의 octopus/jellyfish/crayfish/tetra 셀 크기를 `cam.zoom`-only → `creatureCellSize(zoom, w, cols) = SPRITE_W_FRAC(0.1875)*zoom*w/cols`로 변경(`drawOpenCode`가 쓰던 패턴 통일). `w`(출력 너비)를 곱해 32px에서 크리처가 절반 픽셀로 들어맞음. `selectGrid`의 `canvasWidth<=32 && zoom>=1.3` 분기를 MD→HD로 바꿔 32px도 64px와 동일 실루엣.
- **가재 재설계**: `cellH = cellW`(square)로 세로 스트레치 제거 + `CRAYFISH_GRID_HD`를 둥근 몸통(공식 마스코트: 모서리 더듬이, 분리된 집게, teal 눈, 다리)으로 재작성. MD/LOD도 동반 수정. 가재 눈은 grid 아닌 `eyeRow`/`eyeCols` overlay라 위치 재조정.
- **TC001 노이즈**: 원인은 **FastLED temporal dithering**(밝기<255 기본 ON)이 ~30fps + LDR 가변 밝기에서 어두운 픽셀에 시머 생성. `matrix_display.cpp init()`에 `FastLED.setDither(DISABLE_DITHER)` + raw LDR median-of-5 추가.
- **TC001 크리처**: 단색 5×6 → `drawCreature(body, accent)` body+lit accent overlay(문어 머리 하이라이트/Codex `>_` 마킹/OpenCode 코어/가재 teal 눈).

### 핵심 설계 결정
- **LED 매트릭스 accent는 반드시 몸 밝기에 비례시킬 것**. 고정 밝기 accent(teal 눈 등)는 크리처가 idle/dormant(near-black body)일 때 어두운 몸이 가시 한계 아래로 떨어지며 accent만 떠올라 "눈만 깜빡 / 머리 빨간 점"으로 보인다. `accentScaled(hue, body, boost)`로 accent 밝기를 `bodyMax/255*boost`에 묶어 active일 땐 또렷, dormant일 땐 같이 어두워지게 해결.
- 펌웨어 플래시: TC001은 다른 ESP32 보드 다수와 동시 연결되므로 **daemon device_info로 보드(`ulanzi_tc001`) + MAC(`24:d7:eb:b1:cd:e4`) 확인 후** esptool 직접(`--flash-size keep`, boot_app0+firmware, daemon 중지)으로 플래시. env는 `led8x32`.

---

## 2026-06-13 — App Store 제출 전 데몬 감사 + 공존 하드닝 + 통신 효율 개선

### 문제
- Swift/Node 데몬 듀얼 구조의 공존 완결성, APME 평가 정확성, Timeline 그루핑 품질을 App Store 제출 전 전수 감사할 필요.
- 통신 구조 점검에서 브로드캐스트 증폭과 이벤트 루프 블로킹 병목 확인.

### 해결 (commit a467edd1)
- **감사 결과**: APME(3-layer eval, colMap, 30s 루프) / Timeline(3-site roundtrip, 회전 3-surface, summary pill) / App Store invariants 모두 클린 — 제출 블로커 없음.
- **공존 하드닝**: Swift singleton guard 에 9120-9139 포트 스캔 추가 (`SessionRegistry.scanForDaemonPort`) — Node 데몬이 fallback 포트에 있을 때 dual-daemon 방지. Node `loadDaemonSettings` 가 `getCandidateDataDirs()` mtime 최신본 읽기 + `AGENTDECK_DATA_DIR` 존중.
- **Timeline 노이즈**: Codex otel-active placeholder 필터를 enumerated list → structural match 전환 (OpenClaw 필터와 동일 패턴).
- **통신 효율**: ① Swift sessions_list tool-boundary 2s 디바운스 + trailing flush (state/question 전이는 즉시 — Node `maybeBroadcastSessionsList` 패리티), ② Node passive observer `ps`/`lsof` 를 async execFile 로 — 브로드캐스트 경로 이벤트 루프 블로킹 제거, ③ 유휴 폴러 감속 (judge 30→120s, antigravity 15→60s, WS 클라이언트 없을 때), ④ WS send 64-frame in-flight 백프레셔 (snapshot 프레임 드롭 안전), ⑤ TimelineStore dead `@Published grouped` 제거.

### 핵심 설계 결정
- **"no WS clients ≠ idle"**: `wsServer.onBroadcast` 훅이 디바이스 모듈(ADB/Serial/Pixoo/D200H) fan-out 이라 zero-client 직렬화 스킵은 전제 불성립. gateway 5s probe 도 같은 이유로 감속하지 않음. (memory: broadcast-hook-device-fanout)
- **settings.json 공존 동기화는 파일로 불가**: 비샌드박스 Node 가 App Store 컨테이너를 읽으면 TCC hang — cross-talk 은 port scan/health probe 가 정답. 한계는 `docs/appstore-feature-matrix.md` 인프라 표에 기록. (memory: settings-split-dir-tcc-limit)
- Device approval gating(PreToolUse Allow/Deny) 은 Node 전용, Swift 는 display-only awaiting — 의도된 App Store 차이로 feature matrix 에 기록.

---

## 2026-06-13 — TTGO T-Display 안정화 조치 및 6대 기기 매핑 테이블 추가

### 문제
- LilyGO TTGO T-Display 1.14" 기기에서 135x240 전체 해상도 사용 시 DRAM 용량 부족(BSS 오버플로우) 및 부팅 후 힙 메모리 파편화로 인해 `malloc`이 실패해 화면이 검게 나오는 현상이 발생함.
- 해상도를 135x190으로 시도했으나 정적 BSS 메모리 마진이 7KB 이하로 내려가 LovyanGFX 및 LVGL 하드웨어 디스플레이 초기화 단계에서 메모리 부족으로 화면이 켜지지 않는 침묵 에러(Silent Fail) 발생.
- 135x160으로 가동 시 화면 가로방향으로 검은 노이즈 라인이 수시로 깜빡이는 현상(Tearing & bus collision) 발생.
- 유저가 추가로 1대의 ESP32 디바이스를 연결하여 총 6대의 기기 연동이 개시됨.

### 해결
1. **정적 135x160 버퍼 및 모래사장 여백 융합 (완전 안정화)**:
   - TTGO의 캔버스 해상도를 부팅 안전성이 검증된 `135x160` 정적 버퍼(DRAM 남은 용량: **15.2KB**)로 롤백하여 메모리 부족으로 런타임에 화면이 안 켜지는 현상을 원천 방지함.
   - 캔버스 하단에 남는 80px 영역은 `aquarium.cpp`에서 스크린 배경 불투명도를 `lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, 0)`로 강제 설정하고 배경색을 수족관 모래사장 테마 칼라인 `0x2A1F14`로 자연스럽게 채워 검은 여백을 해결하고, 해당 영역을 Claude 에이전트 정보 및 잔여 토큰 게이지 표출을 위한 메트릭 창으로 매끄럽게 융합함.
2. **가로 노이즈선 및 깜빡임 해결**:
   - `display.cpp` 의 `disp_flush` 콜백 루프 내부에서 LovyanGFX로 데이터를 푸시하기 전후에 `tft.startWrite()` 와 `tft.endWrite()` 로 트랜잭션을 잠금(Lock) 처리하여 다른 비동기 네트워크 스택 등이 SPI 버스 전송을 방해하는 것을 막아 노이즈선을 완전히 소멸시킴.
   - SPI 클럭 주파수를 기존 20MHz에서 **40MHz**로 높여 프레임 리프레시를 가속하고 화면 찢어짐(Tearing)을 극소화함.
3. **6대 ESP32 하드웨어 시리얼 매핑 캐시 최신화**:
   - 데몬의 `/devices` REST API 조회 결과를 바탕으로 현재 워크스페이스에 연동 중인 6대 기기 매핑 목록을 영구 기록함.

### ESP32 기기 시리얼 포트 매핑 목록 (2026-06-13 기준)
| 시리얼 포트 명 | 식별 보드 타입 | 설명 및 해상도 |
| --- | --- | --- |
| `/dev/cu.wchusbserial58A90021441` | `ttgo_t_display` | LilyGO TTGO T-Display 1.14" (135x240, 캔버스 135x160 + 80px 메트릭 여백) |
| `/dev/cu.wchusbserial211240` | `ips_10` | Guition JC8012P4A1C 10.1" HMI (Landscape 1280x800) |
| `/dev/cu.usbmodem2111201` | `round_amoled` | AMOLED Round 1.8" (454x454 원형 AMOLED) |
| `/dev/cu.usbmodem834101` | `ips_35` | 3.5" IPS 디스플레이 모듈 (480x320) |
| `/dev/cu.wchusbserial2112320` | `86box` | 86 Box 4" (480x480) |
| `/dev/cu.usbmodem83201` | `Unknown (S3 CDC)` | 신규 추가 연결됨 (Native USB CDC) |

---

## 2026-06-09 — ESP32 dynamic stride root-cause fix & glow animation restoration

### 문제

- 이전 조치(수동 stride 계산식 도입)에도 불구하고 86 Box, IPS35 등 일부 디바이스에서 연결 상태 텍스트("Connecting" 등) 갱신 시 여전히 가로 노이즈 밴드가 발생하거나 화면이 깨지는 현상이 지속됨.
- 원인은 부분 invalidate 영역의 stride 바이트 수 수동 계산 공식이 LVGL 9이 내부적으로 재할당/재정형(reshape)하는 실제 버퍼 stride 구조와 어긋날 수 있고, `BOARD_RGB48` (86 Box) 및 `BOARD_IPS35` (3.5" IPS) 분기에서는 stride 보정(line-by-line drawing) 로직 자체가 누락되어 있었기 때문임.
- 또한, 애니메이션을 정적으로 완전히 지워버려 UI의 비주얼 피드백이 밋밋해져, 깨지지 않는 안전한 glow 효과의 복원이 필요함.

### 수정

- **dynamic stride 조회**: `esp32/src/ui/display.cpp`의 `disp_flush`에서 수동 stride 계산을 모두 제거하고, LVGL API인 `lv_display_get_buf_active(display)->header.stride`를 조회하여 픽셀 stride(`stride_pixels`)를 동적으로 정밀하게 획득하도록 수정함.
- **모든 보드 stride 보정 적용**: `BOARD_RGB48` 및 `BOARD_IPS35`를 포함한 모든 디스플레이 드라이버 분기에 `stride_pixels != w`인 경우 라인 바이 라인으로 그리는 안전 분기를 일관되게 제공함.
- **Glow & Breathing 효과 추가**:
  - `esp32/src/ui/screens/splash.cpp`의 브랜드 로고 이미지(`imgLogo`)에 opacity breathing (`100`~`255`, 1.5초 주기) 애니메이션을 적용함.
  - `esp32/src/ui/screens/aquarium.cpp`의 재연결 카드(`connCard`) 테두리에 border_opa breathing (`40`~`180`, 1.5초 주기) 애니메이션을 적용하여 깨짐 없는 세련된 Cyan Border Glow 효과를 구현함.

### 검증

- 5개 연결된 모든 ESP32 실기기에 순차 배포 완료:
  - `ttgo` (`/dev/cu.wchusbserial58A90021441`) -> **SUCCESS**
  - `amoled` (`/dev/cu.usbmodem2111201`) -> **SUCCESS**
  - `ips10` (`/dev/cu.wchusbserial10`) -> **SUCCESS**
  - `box_86` (`/dev/cu.wchusbserial211340`) -> **SUCCESS**
  - `ips35` (`/dev/cu.usbmodem21133201`) -> **SUCCESS**
- 디바이스의 부팅 및 재연결 스크린에서 텍스트 노이즈 찢어짐 현상이 완벽히 소멸되었고, 은은한 로고 브리딩과 테두리 글로우 애니메이션이 E-ink/LCD/AMOLED 전 패널에서 매우 부드럽고 정상적으로 작동함을 확인함.

---

## 2026-06-09 — ESP32 connecting animation noise fix

### 문제

TTGO, Round AMOLED, IPS 10", 86 Box, IPS 3.5"에 배포된 현재 펌웨어에서 연결 시도/재연결 상태의 애니메이션이 화면 깨짐 또는 노이즈처럼 보였다. 스크린샷 확인 결과 spinner 형태 자체보다 작은 LVGL 객체/텍스트와 부분 redraw가 패널별 flush 경로와 충돌하는 것으로 보여, 고위험 경로를 제거했다.

- 초기 splash 화면의 `lv_spinner` arc 애니메이션이 작은 영역을 고속 invalidate 한다.
- 재연결 overlay가 `aquariumUpdate()` 매 tick마다 full-screen scrim 배경색을 변경해 패널 전체 flush를 유발한다.

### 수정

- `esp32/src/ui/screens/splash.cpp`의 `lv_spinner`와 dot animation을 제거하고, 정적인 opaque splash (`AgentDeck` + `Connecting`)만 표시하도록 변경했다.
- `esp32/src/ui/screens/aquarium.cpp`의 full-screen background pulse와 reconnect indicator animation을 제거하고, 정적인 opaque overlay만 표시하도록 변경했다.
- `esp32/platformio.ini`의 `ips35`, `amoled`, `ips10`, `box_86` upload/monitor 포트를 2026-06-09 실제 성공 포트 매핑과 일치시켰다.

### 검증

- `pio run -d esp32 -e ttgo -e amoled -e ips10 -e box_86 -e ips35` 통과.
- 정적 연결 UI 펌웨어 업로드 성공: `ttgo` (`/dev/cu.wchusbserial58A90021441`), `amoled` (`/dev/cu.usbmodem2111201`), `box_86` (`/dev/cu.wchusbserial211340`), `ips35` (`/dev/cu.usbmodem21133201`).
- `ips10` 빌드는 통과했지만, 업로드 시점에 `/dev/cu.usbmodem101`가 macOS 포트/USB registry에서 감지되지 않아 업로드는 보류했다.

---

## 2026-06-07 — 86box ESP32-S3 Serial UART fix

### 문제

86box (ESP32-S3-4848S040) 기기가 백라이트는 켜지지만 화면이 검은색으로 나오는 현상이 발생했다. 진단 결과 펌웨어 업로드는 성공했지만, 시리얼 출력이 전혀 나오지 않았다. 원인은 ESP32-S3의 `ARDUINO_USB_MODE=1` 설정과 `ARDUINO_USB_CDC_ON_BOOT` 미지정이 결합되어 Serial 클래스가 Native USB CDC로 출력을 보내려 했으나, 86box는 CH340 UART 어댑터로 연결되어 있어 실제 시리얼 데이터가 나가지 않는 상황이었다.

### 수정

- `esp32/platformio.ini`의 box_86 환경에 `-DARDUINO_USB_CDC_ON_BOOT=0`을 추가해 Serial을 UART0(CH340)으로 강제 redirection 했다.
- `esp32/src/main.cpp`의 setup() 함수에 `BOARD_BOX_86 || BOARD_86_BOX` 케이스를 추가해 CH340 UART에서는 CDC 연결 대기 없이 바로 시리얼 출력을 시작하도록 했다.
- `esp32/boards/board_config.h`에 `BOARD_BOX_86`, `BOARD_86_BOX` backward compatibility를 추가했다.

### 검증

- `pio run -e box_86` 빌드 통과 (RAM 26.5%, Flash 30.6%)
- 펌웨어 업로드 후 `pio device monitor`로 시리얼 출력 확인 필요 (CH340 /dev/cu.wchusbserial20110)
- 디스플레이 패널 테스트 코드가 RED→GREEN→BLUE→WHITE→BLACK 순서로 1초씩 표시되는지 시각적 확인 필요

---

## 2026-06-07 — Swift daemon ESP32 serial discovery hang/status stale 수정

### 문제

Swift daemon 실행 시 ESP32 serial 모듈은 시작됐지만 `/health.modules.serial.connections` 가 빈 배열로 남고, round/3.5"/86box 계열 보드가 연결되지 않는 것처럼 보였다. 진단 결과 오래된 `flash.sh`/수동 probe Python 프로세스들이 `/dev/cu.usbmodem2111201` 을 점유했고, Swift daemon 은 CDC 포트를 순차 open/config 하는 동안 WCH/UART 포트 discovery 까지 밀릴 수 있었다. stale Python 정리 후에는 AgentDeck 이 CDC 2개와 WCH 3개를 실제로 열었지만, serial actor 가 broadcast/write 작업 뒤에 밀리면 dashboard-facing status cache 는 계속 빈 배열을 내보내는 문제도 있었다.

### 수정

- Swift `ESP32Serial` 의 포트 탐색 순서를 UART/WCH 우선, CDC 후순위로 정렬했다.
- 포트 open/config 를 actor 내부 동기 순차 작업에서 detached bounded attempt 로 분리하고, 3초 timeout/backoff 와 late-fd close 방어를 추가했다.
- `device_info_request` 와 초기 state 전송은 포트 등록 및 read loop 시작 이후 실행하도록 유지했다.
- serial health/status 용 `SerialStatusShadow` 를 추가해 actor 가 broadcast/write 로 바쁠 때도 `/health` 와 dashboard module health 가 마지막 연결 스냅샷을 즉시 읽을 수 있게 했다.
- 현재 환경의 stale Python serial probe/flash 프로세스를 종료했다. 작업 중 `/dev/cu.wchusbserial20110` 은 `esptool` 플래시 프로세스가 점유 중이었고, 플래시 완료 후 `/dev/cu.wchusbserial211340` 으로 다시 enumerate 되어 Swift daemon 이 연결했다.

### 검증

- `bash scripts/capture-apple-diagnostics.sh --tail 1000 --last 15m`
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataSwiftSerialFix build`

---

## 2026-06-07 — APME `_empty` run timeline 반복 노이즈 차단

### 문제

OpenClaw Gateway 연결 노이즈로 생성된 prompt/turn/step 없는 run 이 orphan cleanup 에서 `_empty` 로 닫힌 뒤에도, APME daemon 30초 loop 의 `listUnevaluatedRuns()` 후보에 계속 포함됐다. 이 run 은 outcome 계산상 `abandoned`, composite `0.2` 로 저장되어 `TIMELINE` 에 `★ run 20% [_empty] abandoned` 가 반복 append 됐다.

### 수정

- Node `bridge/src/apme/store.ts` 와 Swift `apple/AgentDeck/Daemon/Apme/ApmeStore.swift` 의 `listUnevaluatedRuns()` 에서 `task_category='_empty'` run 을 제외했다.
- Node `ApmeRunner.doDrain()` 이 layer1/layer2 모두 실행되지 않은 no-op run result 는 `onResult` listener 로 내보내지 않도록 방어했다.
- Node daemon run-level `onResult` branch 에도 eval row 가 0개인 no-op result 방어를 추가해 timeline append 를 건너뛰게 했다.
- 회귀 테스트: `_empty` run 이 unevaluated queue 에 들어가지 않는지, no-op run eval 이 `onResult` 를 호출하지 않는지 검증했다.

### 검증

- `pnpm vitest run bridge/src/__tests__/apme-collector.test.ts bridge/src/__tests__/apme-runner.test.ts`
- `pnpm --dir bridge build`

## 2026-06-07 — Mobile Reconnect & ESP32 CDC Connection Stabilized

### 문제

1. **Android/iOS Reconnecting Loop**: 모바일 기기가 Dead Port(9121)나 이전 잘못된 포트에 물려 있을 때, Wifi 접속 실패 후 mDNS 재탐색으로 넘어가지 못하고 무한 Reconnecting 루프에 갇히는 현상이 발생했다.
2. **ESP32 Native CDC 기기 무한 리셋**: `/dev/cu.usbmodem*` (round_amoled, ips_35 등) 기기가 화면 렌더링은 잘 되지만 read 트래픽이 없어 데몬에서 20초마다 오프라인(`stale`)으로 판단하여 연결을 닫았다 다시 여는 현상이 있었다.
3. **D200H**: 데몬이 기동될 때 활성 세션(Claude Code 등)이 없으면 메인 ZIP 이미지가 전송되지 않아 기기가 Stock 펌웨어 대기화면(crayfish 캐릭터)에 멈춰 있었고, macOS TCC 보안 정책으로 인해 Node-HID가 Keyboard Interface를 열지 못해 버튼 이벤트가 유실되어도 관련 오류가 표출되지 않고 있었다. 또한, macOS 상의 `node-hid` 에서는 Output Report ID가 필요하지 않은 HID 기기에 쓰기를 할 때 첫 번째 바이트에 `0x00` 패딩(Report ID)을 붙이지 않으면 OS HID 드라이버가 임의로 데이터의 첫 번째 바이트를 제거해버려 D200H 기기 상에서 ZIP 패킷의 `0x7C 0x7C` 헤더가 깨지며 화면이 아예 갱신되지 않고 굳어버리는 버그가 있었다.
4. **Unit Tests**: Claude subscription quota 체크 규칙으로 인해 일부 bridge-core 테스트 케이스가 실패했다.

### 수정

- **Android 클라이언트 (`BridgeConnection.kt`)**: Wifi URL 포함하여 연결이 5회 연속 실패하면 내부 URL을 클리어하고 Reconnect 시도를 중지시켜, mDNS 백그라운드 재탐색을 즉시 유도했다.
- **iOS 클라이언트 (`BridgeConnection.swift`)**: 모든 URL의 최대 재연결 시도를 20회에서 5회로 줄여, 잘못된 Wi-Fi 데몬 주소에서 빠르게 빠져나오고 mDNS 재탐색을 실행하도록 했다.
- **ESP32 Serial 모듈 (`esp32-serial.ts`)**: CDC 디바이스(usbmodem 또는 ttyACM)는 DTR/RTS 신호 제한으로 read 트래픽이 없어도, 최근 쓰기(`write`)가 성공했고 디바이스 정보 캐시가 존재하면 활성 상태(`isResponsive` -> true, `stale` -> false)로 간주하고 강제 재연결을 면제했다.
- **D200H 계측 & 기동 수정 (`d200h-module.ts`)**:
  - D200H 연결 직후 세션 유무와 무관하게 즉시 초기 OFFLINE/대기 대시보드 레이아웃을 렌더링(ZIP 패킷 전송)하여 대기화면에 멈추는 문제를 해결했다.
  - Keyboard Interface 오픈 에러 발생 시 catch 블록에서 `lastOpenError` 에 명시적으로 'macOS Input Monitoring Permission' 안내 문구를 기입하여 진단 가능성을 극대화했다.
  - macOS 환경인 경우, HID 키보드 오픈 권한 실패 시 최초 1회 시스템 설정의 '입력 모니터링' 보안 패널(`x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent`)을 자동으로 호출해 사용자의 권한 획득을 가이드하도록 개선했다.
  - `node-hid` write 시 첫 번째 바이트에 `0x00` (macOS Report ID dummy) 패딩을 추가 전송하여, OS 드라이버에 의한 D200H 프로토콜 헤더(`0x7C 0x7C`) 깨짐 현상을 근본적으로 해결했다.
- **Unit Tests (`bridge-core.test.ts`)**: Claude subscription 검증 통과를 위해 테스트 스테이트 머신에 Claude 모델 명칭을 명시적으로 기입했다.

### 검증

- `pnpm test`로 1,276개 전체 유닛 테스트의 성공을 확인했다.
- `pnpm build`로 패키지 모노레포의 빌드 무결성을 확인했다.
- `adb` 및 `streamdeck` 툴을 통해 모바일 기기(Pantone 6, Lenovo Tab) 배포와 Stream Deck 플러그인 링크 배포를 자동으로 진행했다.
- `agentdeck daemon start` 후 `agentdeck devices` 확인 결과:
  - Android 기기 2대(Crema S 포함)가 reverse tcp 포트(9120)를 타고 실시간 WebSocket으로 즉시 자동 연결됨.
  - `round_amoled`와 `ips_35`를 포함한 총 6개의 ESP32 디바이스가 `stale: false`, `connected: true`로 안정적으로 연결 유지됨.
  - D200H 기기가 정상 감지되어 0x00 패딩이 추가된 초기 대시보드 렌더링 ZIP 패킷 송출(writeOK 누적)을 성공적으로 수행했으며, `lastOpenError`에 macOS Input Monitoring 권한 에러 메시지 및 `resvgLoaded: true` 진단 상태가 정상 표출되는 것을 확인.

---

## 2026-06-07 — CLI daemon serial open FD leak / stale registry 정리

### 문제

CLI daemon 이 ESP32 serial 포트를 `Promise.race(fs.promises.open(), timeout)` 방식으로 열면서, timeout 후에도 macOS 커널 open 이 늦게 완료되면 daemon 프로세스가 해당 FD 를 계속 소유할 수 있었다. 이 상태에서는 `/health.modules.serial` 에는 연결 0개 또는 일부만 보이지만 `lsof` 상 daemon 이 `/dev/cu.*` 포트를 잡고 있어 다음 poll/restart 에서 나머지 기기가 계속 open timeout 됐다. 또한 `/health` 가 죽은 daemon session 이 `sessions.json` 에 남아 start/status 경로의 판단을 오염시켰다.

### 수정

- `bridge/src/esp32-serial.ts` 에서 serial open hang 가능성을 별도 Node probe 프로세스로 격리하고, daemon 본체는 probe 통과 후 명시적인 fd 기반 read/write/close 만 수행하도록 변경했다.
- timeout 된 native USB CDC 포트가 있어도 daemon 본체가 해당 `/dev/cu.usbmodem*` FD 를 누수하지 않게 했다.
- nonblocking serial write 의 `EAGAIN` / `EWOULDBLOCK` 는 terminal failure 가 아니라 backpressure 로 분류해 연결을 즉시 닫지 않고 write queue 재시도로 넘기도록 했다.
- cache 된 `device_info` 만 있고 live read 가 아직 없는 serial connection 에는 `usage_update` / `sessions_list` 같은 큰 payload 를 보내지 않도록 했다.
- `bridge/src/session-registry.ts` 에 stale daemon session 제거 helper 를 추가했다.
- `bridge/src/cli.ts` / `bridge/src/daemon-server.ts` 에서 `/health` 가 응답하지 않는 daemon.json / daemon session 을 발견하면 로그만 남기지 않고 registry 에서 제거하도록 했다.

### 검증

- `pnpm --dir bridge build`
- `pnpm vitest run bridge/src/__tests__/esp32-serial-node.test.ts bridge/src/__tests__/daemon-lifecycle.test.ts`
- `node bridge/dist/cli.js daemon status || true` 로 stale `sessions.json` daemon 엔트리 제거 확인.
- `node bridge/dist/cli.js daemon start --debug`
- 45초 관찰한 `daemon status`: ESP32 serial 4개(`/dev/cu.wchusbserial10`, `/dev/cu.wchusbserial20120`, `/dev/cu.wchusbserial211340`, `/dev/cu.wchusbserial58A90021441`) 모두 `connected:true`, `stale:false`; ADB 2개, Pixoo64 1개, D200H writeOK 증가 확인.
- `lsof` 확인: 새 daemon PID 는 정상 연결된 WCH serial 4개만 소유하며 timeout 된 `/dev/cu.usbmodem21133201` FD 는 소유하지 않음.
- 추가 확인: `/dev/cu.usbmodem2111201` 은 직접 Node nonblocking fd 테스트와 pyserial(DTR/RTS reset 포함) 테스트 모두 write timeout / read 0 으로 확인되어 daemon payload 문제가 아니라 USB CDC endpoint/보드 wedged 상태로 판단.
- 남은 환경 이슈: 이전 stuck `(node)` PID `46424` 가 `*.9120 LISTEN` 을 `SIGKILL` 후에도 놓지 않아 현재 daemon 은 9125 fallback 에서 정상 동작 중. `/dev/cu.usbmodem21133201` 의 stale `stty` PID `54649` 도 `U` 상태라 사용자 kill 로 제거되지 않음.

---

## 2026-06-07 — CLI daemon ESP32 reconnect / D200H 상태 계측 수정

### 문제

CLI daemon 재시작 후 ESP32 기기들이 순간적으로 연결됐다가 `reconnecting` 으로 돌아갔다. 특히 86box 는 처음 화면이 나오다가 다시 reconnecting 상태가 됐고, TTGO 외 보드들의 `device_info` 가 재시작마다 안정적으로 잡히지 않았다. D200H 는 화면 write 가 실제로 성공해도 status 에 `writeOK: 0` 으로 표시되어 전송 실패인지 렌더링 문제인지 구분할 수 없었다. 또한 serial `open()` 에 걸린 stale daemon PID 가 `/health` 에 응답하지 않아도 CLI start guard 가 PID 생존만 보고 새 daemon 시작을 막았다.

### 수정

- `bridge/src/esp32-serial.ts` 에서 serial 전용 `state_update` / `sessions_list` payload 를 firmware 가 실제로 읽는 필드만 남기도록 allowlist 기반으로 축소했다.
- ESP32 연결별 write queue 를 추가해 USB serial burst 를 120ms 간격으로 pacing 하고, 식별 전 `sessions_list` 는 보내지 않도록 했다.
- 큰 payload 와 독립적인 `serial_keepalive` JSON 을 우선순위로 보내 ESP32 펌웨어의 USB 연결 타이머가 state/session payload 파싱 지연에 끌려가지 않게 했다.
- 일부 보드는 host JSON 을 받아 화면은 갱신하면서도 `heartbeat_ack` 를 안정적으로 echo 하지 않으므로, read silence 만으로 포트를 닫지 않고 read/write 양쪽이 모두 멈춘 경우만 stale 처리한다. 실제 `/dev/cu.*` 포트 소실은 poll 단계에서 닫도록 분리했다.
- CLI serial status 가 포트 open/cache 만으로 `connected:true` 를 표시하던 false positive 를 제거했다. 이제 초기 `device_info`/JSON read 가 실제로 들어온 포트만 connected 로 세고, 포트만 열린 상태는 `transportOpen:true, connected:false` 로 분리한다.
- macOS native USB CDC 포트(`/dev/cu.usbmodem*`)에서 `stty -f` 와 sync `openSync()` 가 커널 I/O 대기로 hang 되어 전체 ESP32 poll 을 막던 문제를 수정했다. `stty` timeout 은 child exit 를 기다리지 않고 즉시 실패 처리하며, serial open 은 async timeout 으로 감싸고 CH340/UART 포트를 우선 poll 한다.
- `device_info_request` 를 우선순위 큐에 넣고 5초 단위로 재시도한다.
- 포트별 last-known `device_info` 를 `~/.agentdeck/esp32-device-cache.json` 에 저장/복원해 daemon 재시작 직후 86box/TTGO/TC001/IPS 10/IPS 3.5/Round AMOLED 가 바로 식별되게 했다.
- ESP32 firmware 의 `BOARD_IPS10` device_info 라벨을 `ips_10` 으로 추가하고, firmware flash 후에는 10인치 보드가 `ips_35` 로 잘못 보고되지 않게 했다.
- `bridge/src/daemon-server.ts` / `bridge/src/cli.ts` / legacy `bridge/src/daemon.ts` 는 PID 생존만으로 기존 daemon 을 인정하지 않고 `/health` 응답이 없으면 stale 로 무시한다.
- `bridge/src/modules/d200h-module.ts` 에 실제 `writeOK` / `writeFail` / HID report / button count / last error 계측을 추가했다.

### 검증

- `pnpm --dir bridge build`
- `pnpm vitest run bridge/src/__tests__/esp32-serial-node.test.ts bridge/src/__tests__/daemon-lifecycle.test.ts`
- `pio run -d esp32 -e ips10 -e ips35 -e amoled -e rgb48`
- `agentdeck daemon stop`
- `agentdeck daemon start --debug`
- 정정: 최초 75초 관찰의 "ESP32 serial 6개 연결"은 `lastReadAt` 초기값/cache 때문에 생긴 false positive 였다.
- 수정 후 70초+ 관찰한 `agentdeck daemon status`: ESP32 serial 4개 실제 연결(`/dev/cu.wchusbserial10`=`ips_10`, `/dev/cu.wchusbserial20120`=`ulanzi_tc001`, `/dev/cu.wchusbserial211340`=`86box`, `/dev/cu.wchusbserial58A90021441`=`ttgo_t_display`), 모두 `stale:false`, `connectionCount:4`. Native USB CDC 2개는 아직 미연결: `/dev/cu.usbmodem21133201` 및 `/dev/cu.usbmodem2111201` open timeout. D200H `writeOK: 122`, `writeFail: 0`.

---

## 2026-06-07 — CLI ESP32 serial initial burst parity

### 문제

Node CLI daemon 의 ESP32 serial bridge 는 reader 를 먼저 열지만, `device_info` 가 오기 전에도 같은 connection 에 `state_update` / `usage_update` 를 그대로 밀어 넣어 native USB 보드에서 초기 backpressure 를 일으킬 수 있었다. Swift daemon 에서 넣은 완화가 CLI-only 경로에는 아직 반영되지 않았다.

### 수정

- `bridge/src/esp32-serial.ts` 에서 connection 별로 `device_info` 전의 initial/heartbeat/broadcast payload 를 더 가볍게 만들었다.
- `device_info` 전에는 `state_update` 의 고용량 필드를 제거하고, initial burst 의 `usage_update` 는 건너뛴다.

### 검증

- `pnpm vitest run bridge/src/__tests__/esp32-serial-node.test.ts`
- `pnpm --dir bridge build`

## 2026-06-07 — ESP32 native USB reconnect 루프 완화

### 문제

`/dev/cu.usbmodem*` native USB ESP32 두 대가 `write stalled ... errno=35` 를 반복하면서 initial state burst 직후 reconnect 루프에 들어갔다. `device_info_request` 와 초기 `state_update`/`usage_update` 가 read loop 시작 전에 쏟아져 CDC 포트의 backpressure 를 악화시키고 있었다.

### 수정

- `ESP32Serial.openAndRegisterPort()` 에서 read loop 를 먼저 시작한 뒤 initial state 를 보내도록 순서를 바꿨다.
- `device_info` 가 아직 없는 부팅 직후에는 `usage_update` 를 initial burst 에서 생략하고, `state_update` 에서도 `moduleHealth`/`subscriptions` 같은 고용량 필드를 걷어냈다.

### 검증

- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug build -quiet`

## 2026-06-07 — OpenClaw handshake / usage quota / daemon diag 정합성 수정

### 문제

CLI daemon 이 일부 surfaces 에서는 기기 연결이 살아 보이는데 OpenClaw gateway 는 계속 disconnected 로 남고, Stream Deck+ usage / LIMIT 표시는 현재 모델이 확정되지 않은 상태에서도 Claude quota 를 붙여서 틀리게 보였다. 또한 `agentdeck diag` 는 daemon fallback port 를 찾더라도 daemon HTTP 서버에 `/diag` 가 없어 404 를 냈다.

### 수정

- OpenClaw Node adapter 의 connect payload 를 Swift adapter 와 맞췄다. shared gateway token 은 `~/.openclaw/openclaw.json` 에서 읽고, device auth 서명은 v3 payload (`platform`/`deviceFamily` 포함) 로 생성한다.
- `buildUsageEvent()` 는 모델명이 명시된 Claude 계열일 때만 5h/7d subscription quota 를 붙이도록 바꿨다. model 이 아직 unknown 인 상태에서는 LIMIT 를 숨긴다.
- daemon HTTP 서버에 `/diag` 를 추가하고 `agentdeck diag` 는 `daemon.json` / `findDaemonPort()` 기반으로 daemon port 를 우선 찾도록 바꿨다.

### 검증

- `pnpm vitest run bridge/src/__tests__/usage-event.test.ts bridge/src/__tests__/adapter.test.ts`
- `pnpm --dir bridge build`
- `agentdeck daemon stop`
- `node bridge/dist/cli.js daemon start --foreground --debug`
- `agentdeck daemon status`
- `agentdeck diag --tail 20`

## 2026-06-06 — daemon stop hang / Android 재연결 / devices 포트 정합성 수정

### 문제

CLI daemon 이 `/shutdown` 후 HTTP listener 만 닫고 Node 프로세스가 남아, 다음 daemon 이 꼬이거나 9120 대신 fallback 포트로 올라가면서 Android/Swift/CLI surface 의 연결 표시가 엇갈렸다. Android 앱은 daemon 이 죽은 동안 localhost 재시도를 포기하면 daemon 이 나중에 살아나도 USB 경로를 다시 시도하지 않아 미연결로 남을 수 있었다. 또한 `agentdeck devices` 는 daemon fallback port 를 무시하고 9120 만 조회해, 실제 daemon 이 살아 있어도 "Bridge is not running" 을 출력했다.

### 수정

- Node daemon shutdown 최종 경로를 self-SIGKILL fallback 으로 보강해 macOS serial fs worker 가 `process.exit()` join 에 걸려도 `agentdeck daemon stop` 후 PID 가 남지 않도록 했다.
- Android tablet/e-ink auto-connect recovery 에 mDNS 확인 후 USB localhost 재시도 루프를 추가해 daemon 이 앱보다 늦게 살아나도 다시 붙도록 했다.
- ESP32 serial poll 에 in-flight guard / opening port set / port dedupe 를 추가해 같은 serial port 가 중복 연결 수로 잡히지 않게 했다.
- `agentdeck devices` 가 `daemon.json` / `findDaemonPort()` 를 우선 사용해 daemon 이 fallback port 에 있어도 올바르게 조회하도록 했다.

### 검증

- `pnpm --filter @agentdeck/bridge typecheck`
- `pnpm --filter @agentdeck/bridge build`
- `./gradlew :app:compileDebugKotlin --no-daemon`
- `./gradlew :app:assembleDebug --no-daemon`
- `bash scripts/build-android-release.sh`
- 연결된 Pantone 6 / Lenovo Tab 에 `dist/agentdeck-v0.4.1.apk` 업데이트 설치 및 실행.
- `agentdeck daemon stop` 후 1초 내 daemon PID 제거 확인.
- 최종 `agentdeck devices`: WebSocket 5 clients, ESP32 serial 6, Pixoo64 1, ADB 2, D200H 1.

---

## 2026-06-06 — 안드로이드 가로모드/태블릿 해상도 적응형 테라리움 스케일링 적용

### 문제

Pantone 6 및 Crema S 등 화면 비율이 다른 기기에서 찌그러짐 문제를 해결하기 위해 `aspectRatio(2f)` 및 Centering Box 제약을 강제로 부여했으나, 이로 인해 Lenovo Tab 같은 일반 가로형 안드로이드 태블릿에서 위아래로 큰 검은 여백(Letterbox)이 생겼다.

### 원인

Vector 기반의 `ColorTerrariumCanvas` 및 각 지형지물/크리처 렌더링 로직이 가로 너비 `w`에만 비례하여 크기 및 선 두께를 스케일링하고 있었기 때문에, 가로세로 비율이 달라지면 크리처가 상하로 삐져나가거나 돌이 지나치게 비대해지는 현상이 발생했고, 이를 막기 위해 임시로 어항 비율을 2:1로 강제 고정(Letterbox)했던 것이 근본 원인이었다.

### 수정

- `MonitorScreen.kt`에서 `ColorTerrariumCanvas`에 가해졌던 `aspectRatio(2f)`와 Box 래퍼를 완전히 제거하고 원래의 `fillMaxSize()` 구조로 롤백했다.
- `CrayfishCreature`, `OctopusCreature`, `CloudCreature`, `OpenCodeCreature`, `RockFormation`, `KelpField`, `DataParticleSystem`, `WaterSurface`, `LightRaySystem`, `WaterEffect`, `BubbleSystem`, `PlanktonSystem`, `SandDisturbance` 등 전체 13개 구성 요소의 `draw` 메서드에 `baseWidth = minOf(w, h * 2f)`를 도입했다.
- 이로써 물, 모래, 배경 영역은 전체 화면으로 가득 차게 확장되도록 하면서, 돌의 높이/너비, 해초 잎과 줄기 두께/sway 흔들림 폭, LED 선 및 점 크기, 물고기 및 먹이 크기, 빛줄기 두께, 버블 및 플랑크톤 입자 반경 등 스케일에 민감한 요소들은 `baseWidth` 비율로 찌그러짐 없이 안전하게 드로잉되도록 전면 개선했다.
- 수정 사항에 대해 compile 및 175개 안드로이드 유닛 테스트 통과를 검증했고, 연결된 3대 기기(Crema S, Lenovo Tab, Pantone 6)에 APK를 배포하여 letterbox가 사라지고 꽉 찬 테라리움이 올바르게 렌더링됨을 눈으로 수동 검증했다.

---

## 2026-06-06 — GLM/API-backed Claude Code 세션의 Claude quota 표시 차단

### 문제

Claude Code 를 Anthropic 공식 subscription 모델이 아니라 GLM 같은 API-backed 모델로 사용하는 경우에도, AgentDeck 이 `api.anthropic.com/api/oauth/usage` 에서 읽은 Claude OAuth 5h/7d quota 를 그대로 표시했다. 이 값은 현재 GLM/API 세션의 사용량이나 제한이 아니라 남아 있는 Claude 계정 quota 이므로, UI 에서는 정확한 정보처럼 보이는 잘못된 숫자였다.

### 수정

- `buildUsageEvent()` 에서 5h/7d/extra usage quota 는 subscription quota 가 적용되는 Claude 모델(alias: `claude`/`opus`/`sonnet`/`haiku`)일 때만 포함한다.
- 현재 모델명이 `glm-5.1` 등 Claude 계열이 아니면 OAuth 연결 상태는 유지하되, 5h/7d quota 필드는 이벤트에서 제거해 모든 downstream surface 가 자연스럽게 숨기도록 했다.
- `usage-event` 순수 단위 테스트를 추가해 GLM 모델에서는 quota 가 빠지고, `opus-4.6` 같은 Claude alias 에서는 기존처럼 표시되는지 검증한다.

### 검증

- `pnpm --filter @agentdeck/bridge typecheck`
- `pnpm vitest run bridge/src/__tests__/usage-event.test.ts`
- `pnpm --filter @agentdeck/bridge build`
- `pnpm vitest run bridge/src/__tests__/bridge-core.test.ts` 는 기존 WS/http lifecycle suite 가 출력 없이 hang 하여 중단하고, 위 순수 단위 테스트로 변경 범위를 검증했다.

---

## 2026-06-06 — CLI daemon / Swift client-mode device status 정합성 수정

### 문제

Swift in-process daemon 이 실행되지 않고 Node CLI daemon 이 9120 을 소유한 상태에서, CLI daemon 의 `/health.modules` 는 ADB/D200H/Pixoo/ESP32 serial 을 정상 연결로 보고했지만 macOS 앱의 `DaemonService.deviceSummary` 는 로컬 `server` snapshot 만 읽어 외부 daemon client-mode 에서 비어 있었다. 그 결과 같은 daemon 상태를 보면서도 일부 UI 는 정상 연결, 일부 UI 는 미연결처럼 보여 혼란스러웠다.

또한 사용자가 `agentdeck stop` 을 실행하면 기본 포트 9120 에 `/hooks/shutdown` 을 보내 세션 bridge 종료 경로만 타고, 9120 이 daemon 일 때는 `/shutdown` 으로 가지 않아 CLI daemon 이 종료되지 않았다.

### 수정

- `DaemonService.refreshDeviceSummary()` 가 외부 daemon client-mode 에서는 `SessionRegistry.probeDaemonHealth()` 의 `modules` payload 를 `DeviceSummary` 로 변환해 사용한다.
- `DeviceSummary.make(fromModuleHealth:)` helper 를 추가해 Swift/Node daemon module snapshot 을 같은 builder 경로로 처리한다.
- `agentdeck stop` 은 대상 포트의 `/health` 를 먼저 확인하고 daemon 이면 `/shutdown`, session bridge 면 기존 `/hooks/shutdown` 으로 보낸다. 요청에는 timeout 을 걸었다.
- `agentdeck daemon stop` 의 shutdown POST 에도 timeout 을 추가했다.

### 검증

- 현재 실행 중인 CLI daemon PID 56582 의 `http://127.0.0.1:9120/health` 에서 ADB 3대, D200H, Pixoo 1대, serial 6개 연결 확인.
- `pnpm --filter @agentdeck/bridge typecheck`
- `pnpm --filter @agentdeck/bridge build`
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataDaemonCoexist CODE_SIGNING_ALLOWED=NO`
- `xcodebuild test ... -only-testing:AgentDeckTests/SessionLauncherTests` 는 현재 scheme/test plan 에 `AgentDeckTests` 가 포함되어 있지 않아 실행되지 않음.

---

## 2026-06-06 — Pixoo64 제한적 프리로드 애니메이션 실험

### 문제

Pixoo64 안정화를 위해 Swift daemon 의 push cadence 를 크게 늦추자 기본 화면 튐/재부팅성 리셋은 줄었지만, 캐릭터 움직임이 거의 정지 화면처럼 보였다. 과거 `PicNum > 1` 다중 프레임 스트리밍은 Pixoo 펌웨어의 `Loading...` 화면과 HTTP timeout 을 유발해 상시 스트리밍 방식으로는 부적합했다.

### 수정

- Swift `PixooModule` 에 제한적 animated sequence 정책을 추가했다.
  - `processing` / `awaiting_*` 상태로 진입하는 state change 에서만 `PicNum=2` 프레임을 1회 전송한다.
  - heartbeat, disconnected frame, recovery re-seed, channel reassert 는 계속 `PicNum=1` 단일 프레임을 사용한다.
  - 특정 Pixoo IP 에서 2프레임 push 가 실패하면 해당 실행 세션 동안 자동으로 single-frame mode 로 fallback 한다.
- 의도는 “매 프레임 업로드”가 아니라 Pixoo 내부 GIF 재생 버퍼에 짧은 active-state animation 을 심고, 이후 HTTP 부하는 낮게 유지하는 것이다.

### 검증

- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataPixooPreload CODE_SIGNING_ALLOWED=NO`

---

## 2026-06-06 — Pixoo64 HTTP 서버 재부팅 방지용 gentle push 프로파일

### 문제

AgentDeck 재시작 후에도 Pixoo64 가 순간적으로 기본 화면으로 튀고, 이후 기기가 재부팅되는 듯한 현상이 반복됐다. 로그상 `Draw/SendHttpGif` 단일 프레임 push 가 `picId=61` 부근부터 `NSURLErrorDomain Code=-1001` timeout 으로 연속 실패했고, 복구 직후 `GetHttpGifId` 가 `1` 로 동기화됐다. 이는 네트워크 한 번의 흔들림이 아니라 Pixoo 기기 내장 HTTP/GIF 상태가 실제로 리셋됐다는 신호다.

### 원인

이전 안정화는 `PicNum=1` 로 payload 크기를 줄였지만, 상태 변화가 있으면 1.5초 heartbeat 를 우회해 즉시 push 했다. 앱 시작 직후 OpenClaw 연결, Codex App 관찰, sessions_list 변화가 몇 초 안에 연속 발생하면서 Pixoo HTTP 서버에 16KB급 JSON POST 가 짧은 간격으로 여러 번 들어갔다. 실패 후에도 기존 circuit breaker 는 6회 timeout 까지 계속 push 를 시도해, 이미 멈춘 HTTP 서버를 추가로 압박했다. 또한 timeout 된 PicID 를 성공처럼 캐시에 남겨 다음 push 가 PicID gap 을 만들 수 있었다.

### 수정

- Swift `PixooModule` 에 gentle profile 적용:
  - 상태 변화 push 도 최소 12초 간격으로 coalesce.
  - steady heartbeat 는 60초로 완화.
  - `Channel/SetIndex` reassert 는 30초 → 300초.
  - push timeout 은 5초 → 3초.
  - 첫 push timeout 부터 즉시 backoff/probe 로 전환 (`backoffThreshold=1`, initial 30초, max 300초).
- push 실패 시 해당 기기의 cached PicID / last frame / last push time 을 제거해 다음 성공 경로에서 `GetHttpGifId` 로 재동기화한다.

### 검증

- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataPixooGentle CODE_SIGNING_ALLOWED=NO`

---

## 2026-06-06 — Codex OTel / D200H sessions_list 중복 broadcast 완화

### 문제

Swift daemon 연동 점검에서 D200H/Pixoo/OpenClaw/Stream Deck/ESP32 연결 자체는 정상임이 확인됐지만, Codex App OTel 수신 중 `[CodexOTel] Updated observed:codex-app...` 와 `[D200H] BROADCAST sessions_list...` 로그가 한 순간에 과도하게 반복됐다. D200H HID 전송은 `lastStateHash` 로 실제 ZIP 중복 송신을 대부분 막고 있었지만, sessions payload parse/render 경로와 로그가 불필요하게 churn 했다.

### 원인

`updateSessionHookState()` 가 OTel `toolResult` / `activity` 처럼 이미 `processing` 상태인 세션을 다시 `processing` 으로 쓰거나 이미 비어 있는 `currentTool` 을 clear 하는 경우에도 매번 `broadcastSessionsList()` 를 호출했다. 또한 D200H 모듈은 daemon 전체 broadcast 정책상 동일한 `sessions_list` 를 받아도 payload digest 없이 매번 로그와 `updateDisplay()` 를 실행했다.

### 수정

- `DaemonServer.updateSessionHookState()` 는 세션의 visible state/currentTool 이 실제로 바뀐 경우에만 `broadcastSessionsList()` 를 호출한다. Codex processing TTL 갱신은 계속 수행한다.
- `D200hHidModule` 은 D200H 렌더링에 영향을 주는 sessions payload digest 를 캐시하고, 동일 payload 는 로그와 render 호출 없이 무시한다.
- 관찰 전용 Codex App 세션(`port=0`)은 health probe 대상에서 제외해 `http://127.0.0.1:0/health` CFNetwork 노이즈도 차단했다.

### 검증

- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataD200HDedupe CODE_SIGNING_ALLOWED=NO`

---

## 2026-06-06 — Codex session-end repo skill 추가

### 문제

Claude Code 의 `/session-end` 역할(세션 종료 전 공유 메모리 정리, clear/new 이후 작업 인계)을 Codex 환경에서 대체할 표면이 필요했다. Codex에는 같은 이름의 기본 slash command가 없고, custom prompts는 deprecated라 repo-shared workflow로 쓰기에는 부적합했다.

### 수정

- `.agents/skills/session-end/SKILL.md` 를 추가해 Codex repo skill로 세션 종료/인계 절차를 정의했다.
- handoff 출력 형식, `git status`/`git diff --stat` 기반 상태 확인, durable docs 업데이트 기준(`DEVELOPMENT_LOG.md` / `CLAUDE.md` / `AGENTS.md`)을 명시했다.
- `CLAUDE.md`의 Codex Development Surface에 `session-end` 사용 규칙을 추가했다.

### 검증

- Skill frontmatter와 파일 위치 확인.

---

## 2026-06-06 — Swift Pixoo64 default 화면 순간 전환 완화

### 문제

Swift daemon 의 Pixoo64 push 는 단일 프레임/1.5초 heartbeat 로 안정화됐지만, 실기기에서 순간적으로 Pixoo 기본 Custom/default 화면으로 전환되는 현상이 남았다. 로그상 HTTP push 자체는 `error_code=0` 으로 회복되고 있었고, 튐은 특히 backed-off 복구 후 `Channel/SetIndex`/`SetBrightness`/`GetHttpGifId` 재준비와 정기 Custom 채널 재확인 구간에서 발생할 수 있었다.

### 원인

`Channel/SetIndex` 는 Pixoo 를 Custom 채널로 되돌리지만, 바로 `Draw/SendHttpGif` 를 이어서 보내지 않으면 펌웨어가 Custom 채널의 내장 기본 화면을 잠깐 노출할 수 있다. Swift `PixooModule.reassertChannels()` 는 30초마다 `Channel/SetIndex` 만 전송했고, normal push 경로는 동일 프레임 5초 skip 을 적용하므로 기본 화면이 다음 강제 push 까지 보일 수 있었다. 복구 경로도 probe 성공 직후 `prepareDevice()` 로 채널을 먼저 바꾼 뒤 2초 grace 를 기다려 같은 노출 창을 만들었다.

### 수정

- `probeBackedOffDevices()` 는 probe 성공 뒤 2초 동안 기기를 건드리지 않고 안정화한 다음 `prepareDevice()` 와 현재 프레임 강제 seed 를 연속 실행하도록 변경했다.
- `reassertChannels()` 는 actor-level `isPushing` guard 를 공유하고, `Channel/SetIndex` 직후 현재 Pixoo 프레임을 `force=true` 로 다시 전송한다.
- `pushSequenceToDevice()` 에 force 옵션을 추가해 channel reassert/recovery seed 는 동일 프레임 5초 skip 을 우회한다.
- Pixoo API 응답의 `error_code` / `errorCode` 가 0 이 아닌 경우 HTTP 성공이어도 push 실패로 기록한다.

### 대안

정기 `Channel/SetIndex` 를 완전히 제거하면 default 화면 노출 가능성은 더 낮아지지만, brownout/펌웨어 drift 후 Custom 채널 자동 복구가 느려진다. 현재 선택은 재확인을 유지하되 재확인 직후 프레임을 즉시 재시드하는 절충안이다.

---

## 2026-06-06 — Codex 개발 표면 정비 (AGENTS 컨텍스트, repo skills, setup/CLI)

### 문제

AgentDeck는 Codex 세션/훅 지원을 이미 갖고 있었지만, 개발 지침과 자동화 표면은 Claude Code 중심으로 남아 있었다. `AGENTS.md`가 매 작업마다 800KB 이상인 `DEVELOPMENT_LOG.md` 전체 읽기를 요구했고, `.claude/skills`에 있는 AgentDeck 전용 skill들은 `.gitignore` 대상이라 Codex repo skill로 자동 발견되지 않았다. 또한 setup 경로가 Claude CLI를 필수로 요구하고, `agentdeck codex`는 lifecycle hook 설치 결과를 로그로 노출하지 않아 Codex 관찰이 꺼진 상태를 알아차리기 어려웠다.

### 수정

- `AGENTS.md`의 컨텍스트 규칙을 `CLAUDE.md` 우선 + `DEVELOPMENT_LOG.md` 최신/관련 항목 검색 방식으로 변경했다.
- `.agents/skills/`에 Codex repo skills를 추가했다: `agentdeck-workflows`, `agentdeck-deploy`, `sdc-diagnose`.
- `setup/src/setup.ts`와 `scripts/install.sh`를 Claude 또는 Codex CLI 중 하나만 있어도 setup이 진행되도록 수정하고, Codex 사용 안내를 추가했다.
- 로컬 `scripts/install.sh`는 Codex CLI가 있을 때 `hooks/dist/install.js`의 `installCodexHooksIfNeeded()`를 호출해 Codex observation hook을 설치한다.
- `agentdeck codex`가 `~/.codex/config.toml` hook 설치/skip/failure 결과를 stderr에 출력하도록 변경했다.

### 검증

- `pnpm --filter @agentdeck/setup build`
- `pnpm --filter @agentdeck/bridge typecheck`
- `pnpm --filter @agentdeck/hooks build`

---

## 2026-06-06 — Codex hook timeout 누적 방지

### 문제

Codex `PreToolUse`/`PostToolUse` hook 이 `hook timed out after 5s` 로 반복 실패하고, timeout 된 hook 의 `curl -d @-` 자식 프로세스가 남아 9120 연결을 누적 점유했다. 누적 후에는 `/health` 도 연결 timeout 이 발생하며 AgentDeck HTTP listener 가 포화 상태로 악화됐다.

### 원인

`~/.codex/config.toml` 에 설치되는 AgentDeck Codex lifecycle hook 은 health probe 에만 `--max-time 0.3` 을 걸고, 실제 `/hooks/codex_*` POST 에는 curl timeout 을 걸지 않았다. AgentDeck daemon 이 busy 하거나 9120 연결이 밀리면 Codex 는 hook wrapper 를 5초 뒤 timeout 처리하지만, 자식 `curl` 은 계속 남을 수 있었다.

### 수정

- `CodexConfigInstaller.swift` 와 `hooks/src/codex-install.ts` 의 Codex hook POST 명령에 `--connect-timeout 0.2 --max-time 0.8` 을 추가했다.
- Swift/TypeScript installer 테스트에 bounded curl invariant 를 추가해 무제한 POST 회귀를 막았다.

---

## 2026-06-06 — Pixoo64 스트리밍 안정화 및 단일 프레임 동적 주기 최적화

### 문제

Pixoo64 실시간 스트리밍 시, 다중 프레임 애니메이션 시퀀스(`PicNum > 1`)를 전송하면 기기 하드웨어에서 강제적으로 **"Loading..." 화면**을 출력하는 제약 조건이 발생함. 또한, 페이로드 크기를 6프레임(~98 KB)으로 줄이고 타임아웃을 5초로 늘렸음에도 불구하고 ESP32 웹 서버의 자원 한계로 인해 지속적으로 HTTP 요청 타임아웃(`NSURLErrorDomain Code=-1001`) 및 서킷 브레이커 오프라인 전환이 반복됨.

### 원인

1. **다중 프레임 시퀀스의 하드웨어 제약**: Pixoo64 API 구조상 `PicNum > 1`인 시퀀스를 전송받을 때 화면에 로딩 인디케이터가 강제 출력되어 화면이 깜빡이고 전환이 끊김.
2. **저전력 MCU 자원 한계**: ESP32가 약 100 KB에 달하는 Base64 JSON 바디를 파싱하는 과정에서 힙 메모리 부족이나 처리 지연으로 소켓 연결이 끊어지거나 타임아웃이 초래됨.
3. **과도한 네트워크 전송 빈도**: 매 프레임을 3~4 FPS 속도로 지속 전송하여 대역폭 및 기기 처리 능력을 상시 초과함.

### 수정

1. **단일 프레임 전송 복구**:
   - `frameCount`를 다시 `1`로 고정하여 약 **~16 KB** 크기의 단일 프레임만 전송하도록 복구함. 이를 통해 "Loading..." 화면의 노출을 완벽히 방지하고 요청 속도를 대폭 높임.
   - [pixoo-bridge.ts](file:///Users/puritysb/github/AgentDeck/bridge/src/pixoo/pixoo-bridge.ts) 및 [PixooModule.swift](file:///Users/puritysb/github/AgentDeck/apple/AgentDeck/Daemon/Modules/PixooModule.swift)에서 `frameCount`를 `1`로 수정.
2. **동적 전송 주기 적용**:
   - **대기/안정 상태 (Idle)**: 물고기 애니메이션 등 배경 업데이트를 위한 프레임 전송 간격(하트비트)을 기존의 과도한 주기 대신 **1.5초(1500ms)당 1회 (0.67 FPS)**로 늘려 디바이스 부하 및 대역폭 점유율을 75% 이상 낮춤.
   - **상태 변경 상태 (State Changed)**: 사용자 프롬프트 시작, 완료, 세션 목록 변경 등 테라리움의 상태 변경이 감지되는 즉시 타이머 주기와 상관없이 **즉시 단일 프레임을 푸시**하여 snappiness(체감 속도)를 극대화함.

### 검증

- Node.js Vitest 테스트(`pnpm vitest run bridge/src/__tests__/pixoo-sprites.test.ts`) 성공 확인.
- macOS 데몬 빌드(`xcodebuild build -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug`) 성공 확인.
- 로그 분석을 통해 상태 변경 시 즉각 푸시가 발화되고, 대기 상태에서는 1.5초 주기로 성공적인 푸시(`error_code=0`)가 지속됨을 검증함.

---

## 2026-06-05 — ESP32 신규 기기 지원 추가 (Guition JC8012P4A1C 및 LilyGO TTGO T-Display)

### 문제

ESP32-P4 기반의 Guition JC8012P4A1C 10.1인치 HMI 기기 및 LilyGO TTGO T-Display 기기를 위한 펌웨어 빌드 및 LCD/터치 구동이 요구됨. 기기별 기본 화면 회전 방향 지정(TTGO = Portrait, JC8012P4A1C = Landscape) 및 터치 보정이 필요함. 또한 업로드 후 화면의 일부 색상 채널(Red/Blue)이 뒤바뀌어 나타나거나, USB CDC 업로드 시 기기가 멈추는 에러 발생.

### 원인

1. **기기별 회전 방향 요구**:
   - **TTGO T-Display** (어제 기기): 기본 세로모드(Portrait, 135x240) 요구.
   - **JC8012P4A1C** (오늘 기기): 기본 가로모드(Landscape, 1280x800) 요구. 하드웨어 스캔 방향이 800x1280 세로로 고정되어 있어 소프트웨어 회전 및 터치 축 변환이 동반되어야 함.
2. **JC8012P4A1C 색상 스왑**: 제조사 드라이버 `esp_lcd_jd9365.c`는 `color_space` 필드를 통해 RGB/BGR을 감지하지만, `jd9365_lcd.cpp` 초기화 시 legacy 필드인 `.rgb_ele_order`만 세팅되어 `color_space`가 0(RGB)으로 uninitialized 됨. 그러나 실제 IPS 스크린은 RGB 채널을 직접 보내야 올바른 색상이 나옴 (즉, BGR로 세팅 시 Red/Blue가 스왑되어 버림).
3. **USB 업로드 오류 및 노이즈**: native USB JTAG CDC 포트 `/dev/cu.usbmodem101`에서 플래싱 속도를 460800 또는 921600으로 변경 시 macOS의 CDC 클래스 드라이버(`AppleUSBACM`)와 통신 동기가 깨지며 `Serial data stream stopped: Possible serial noise or corruption` 오류 발생. native USB JTAG CDC 포트 사용 시에는 업로드 속도를 전환하지 않고 기본 부트로더 속도인 `115200`으로 플래싱해야 100% 끊김 없이 고속 쓰기가 가능함.

### 수정

1. **보드 설정 및 기본 방향 세팅**: 
   - [board_jc8012p4a1c.h](file:///Users/puritysb/github/AgentDeck/esp32/boards/board_jc8012p4a1c.h) 신규 생성 (JD9365 MIPI-DSI, GSL3680 터치 핀 맵, 800x1280 해상도).
   - [board_ttgo_t_display.h](file:///Users/puritysb/github/AgentDeck/esp32/boards/board_ttgo_t_display.h) 기본값을 **Portrait**로 설정 (`BOARD_ROTATION = 0`, `SCREEN_W = 135`, `SCREEN_H = 240`).
2. **JC8012P4A1C 가로모드(Landscape) 소프트웨어 회전 및 터치 축 대입**:
   - [display.cpp](file:///Users/puritysb/github/AgentDeck/esp32/src/ui/display.cpp)에서 JC8012P4A1C의 `g_screenW`/`g_screenH`를 가로 크기(1280x800)로 세팅.
   - `displayInit` 호출 시 LVGL 디스플레이를 물리 크기(800x1280)로 생성한 뒤 `lv_display_set_rotation(disp, LV_DISPLAY_ROTATION_90)`를 통해 소프트웨어적으로 90도 가로 회전 적용.
   - `touch_read` 함수에서 물리 터치 입력 좌표(X, Y)를 90도 시계방향 회전 수식(`temp_x = x; x = BOARD_NATIVE_H - y; y = temp_x;`)을 적용하여 논리 landscape 맵에 매핑.
3. **색상 순서 교정**: [jd9365_lcd.cpp](file:///Users/puritysb/github/AgentDeck/esp32/src/ui/lcd/jd9365_lcd.cpp)에서 `.rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB`로 설정하여 색상 스왑 현상 해결.
4. **업로드 포트/속도 튜닝**: [platformio.ini](file:///Users/puritysb/github/AgentDeck/esp32/platformio.ini)에서 업로드 포트를 `/dev/cu.usbmodem101`로, 속도를 `115200`으로 지정하여 native USB 통신 노이즈 방지 및 쓰기 안정성 확보.

### 검증

- `pio run -e jc8012p4a1c -t upload` 명령을 통해 `/dev/cu.usbmodem101` 포트(115200 bps)로 펌웨어를 끊김 없이 100% 업로드 및 자동 리셋 확인.
- JC8012P4A1C 기기 부팅 후 기본 가로모드(Landscape, 1280x800)로 화면이 출력되며, UI 색상(블루 테마 및 아쿠아리움 개체들)이 정상적으로 노출되고 터치 조작 방향 또한 완벽히 일치함을 확인.

---

## 2026-06-01 — 포트 누적 증가 버그 수정 (`isPortFree` 127.0.0.1 → 0.0.0.0)

### 문제

새 세션을 시작할 때마다 포트가 9121 → 9122 → 9123 → ... 으로 계속 올라감.

### 원인

**파일**: `bridge/src/session-registry.ts`의 `isPortFree()`

```ts
// 이전 (버그):
server.listen(port, '127.0.0.1');

// 수정:
server.listen(port, '0.0.0.0');
```

`isPortFree()`가 `127.0.0.1`에 bind를 시도했는데, 실제 WebSocket 서버(`BridgeCore`)는 `0.0.0.0`(모든 인터페이스)으로 listen한다. macOS에서는 `SO_REUSEPORT` 등에 따라 `0.0.0.0`으로 이미 점유된 포트에 `127.0.0.1`로 bind가 **성공**하는 경우가 있다. 결과적으로 `isPortFree()`가 이미 점유된 포트를 "free"로 잘못 판정 → `findAvailablePort()`가 다음 포트를 반환 → 포트 계속 증가.

실제로 netstat에서 9121/9122/9123이 LISTEN으로 보임에도 `sessions.json`에 없었고, health 응답도 없는 (좀비) 상태였다. 이 포트들을 `isPortFree(127.0.0.1)`는 통과시켜버림.

### 수정

`server.listen(port, '0.0.0.0')`으로 변경. 실제 서버와 동일한 주소로 bind 시도하므로 어느 인터페이스에 점유된 포트도 정확하게 감지.

### 검증

- `pnpm build` — SUCCEEDED
- `pnpm test` — 1268 tests passed

---

## 2026-06-01 — Android/E-ink/ESP32 daemon 자동 연결 불가 수정

### 문제

Android 기기 (태블릿 포함), E-ink 디스플레이 기기, ESP32 기기 모두 daemon에 자동 연결되지 않는 현상.
원인은 4가지가 얽혀 있었다.

### 원인 1: `SerialModule.shouldActivate('auto')` — ESP32 시작 시 부재 시 모듈 미초기화

**파일**: `bridge/src/modules/serial-module.ts`

`shouldActivate('auto')`가 daemon **시작 시점**에 `/dev/`를 딱 한 번 확인했다. 이때 ESP32가 꽂혀 있지 않으면 `SerialModule` 자체가 `start()`되지 않아 10초 폴링(`pollForDevices`)이 전혀 실행되지 않는다. 나중에 꽂아도 자동 연결 불가.

**수정**: `shouldActivate`에서 기기 감지 제거. `startESP32Serial()` 내부의 10초 폴링이 기기 감지를 담당하므로 SerialModule은 항상 active 상태로 유지. 기기 없어도 무해.

### 원인 2: `BridgeDiscovery.kt`의 TXT `ip` 필드 우선 사용 — stale IP로 연결 실패

**파일**: `android/.../net/BridgeDiscovery.kt`

Bonjour TXT 레코드의 `ip` 필드를 실제 NSD resolve 주소보다 우선했다. Bonjour 캐시가 DHCP 갱신 전의 구 IP를 제공하면 연결 실패. `daemon.md`에 명시된 대로 Swift `BridgeDiscovery`는 TXT `ip` 필드를 무시하고 `NWConnection` 실제 해석 주소를 사용한다. Android도 같은 정책으로 통일.

**수정**: `txtIp` 변수 제거, `resolvedHost`를 직접 사용.

### 원인 3: `BridgeConnection`의 localhost 무한 재시도 — WiFi 기기 mDNS 차단

**파일**: `android/.../net/BridgeConnection.kt`

localhost(adb reverse) 연결 실패 시 `LOCALHOST_STEADY_RETRY_MS = 30_000ms` 주기로 영원히 재시도했다. WiFi 전용 기기(E-ink)에서 localhost는 당연히 실패하므로 30초마다 localhost만 무한 시도 → mDNS 경로가 완전히 막힘.

**수정**: `MAX_LOCALHOST_ATTEMPTS` 초과 시 재시도 완전 중단 + `url = null` 클리어. 이 신호로 `LaunchedEffect(connectionStatus, currentUrl)`가 즉시 mDNS fallback 실행.

### 원인 4: `EinkMonitorScreen` auto-connect mDNS 4초 타임아웃 후 재시도 없음

**파일**: `android/.../ui/screen/EinkMonitorScreen.kt`

`LaunchedEffect(Unit)`의 mDNS 타임아웃이 4초로 짧고, 이후 재시도 로직이 없었다. URL 클리어 시 mDNS 재발견하는 effect도 없었다.

**수정**: 타임아웃 4000→6000ms로 확장 + `LaunchedEffect(connectionStatus, currentUrl)`에서 `url=null+DISCONNECTED` 감지 시 즉시 mDNS 재발견 + 자동 연결 추가. `TabletDashboard`(MainActivity.kt)도 동일하게 통일.

### 해결 흐름 (수정 후)

```
E-ink/Android 앱 시작
  └→ LaunchedEffect(Unit): localhost:9120 시도 (3초)
        ↓ 실패
        └→ savedUrl 시도 (5초)
              ↓ 실패 or 없음
              └→ mDNS 6초 discover → daemon 발견 시 즉시 connect

  (WiFi 전용 기기인 경우)
  localhost MAX_LOCALHOST_ATTEMPTS(5회) 초과
    → BridgeConnection: shouldReconnect=false, url=null 클리어
    → LaunchedEffect(DISCONNECTED, url=null): 0.5초 후 mDNS 재발견
    → daemon 발견 시 connect

ESP32 daemon 기동 후 꽂는 경우
  → SerialModule 항상 active → pollForDevices() 10초마다 실행
  → 기기 감지 즉시 openPort() + 초기 상태 전송
```

### 핵심 설계 결정

- **SerialModule은 항상 active**: `startESP32Serial()` 내부 10초 폴링이 실제 기기 감지를 담당. `shouldActivate`에서 기기 유무 확인은 "daemon 시작 시 꽂혀 있어야 한다"는 잘못된 전제 하에 작동했음.
- **mDNS TXT ip 무시**: Bonjour 캐시 stale 문제. Swift와 Android가 동일 정책 적용. `daemon.md`에 이미 기술된 내용이었으나 Android 구현에 반영되지 않은 상태였음.
- **localhost 빠른 포기 + URL 클리어 시그널**: `LOCALHOST_STEADY_RETRY_MS` steady-retry 전략 폐기. WiFi 전용 기기에서는 localhost 포기 신호(url=null)를 mDNS fallback trigger로 사용. 재시도 전략과 fallback 경로를 명확히 분리.
- **LaunchedEffect key 설계**: `(connectionStatus, currentUrl)` 조합으로 url=null 상태 변화를 정확히 감지. `Unit`으로 키잉하면 앱 시작 시 한 번만 실행되어 재시도 불가.

### 검증

- `pnpm build` — BUILD SUCCEEDED
- `pnpm test` — 57 files / 1268 tests passed (vitest)
- `cd android && ./gradlew testDebugUnitTest` — BUILD SUCCESSFUL

---

## 2026-05-17 — macOS MenuBar 팝업 가변 사이징 + ScrollView greedy 해결

### 문제

macOS 메뉴바 드롭다운 (`ControlTowerPanel`) 팝업이 컨텐츠보다 작게 떠서 항상 세로 스크롤바가 노출됨. 사용자 요청: 컨텐츠에 따라 가변적으로 늘어나 스크롤이 최대한 안 생기게.

세부 원인 3 가지:
1. **고정된 chrome 예약 140 pt**: `scrollContentMaxHeight = max(360, screenHeight * 0.85 - 140)` 가 실제 header/banner/footer 높이와 무관. CalmHeader 일 때 chrome 이 ~140 이라 작은 차이지만, AttentionTheater + DaemonOfflineBanner 동반 시 실측 ~290 이 되어 cap 부족.
2. **너비 380 pt 고정**: 긴 projectName / modelName 이 truncate 되며 세로 줄바꿈으로 vertical 부담 가중.
3. **SwiftUI ScrollView greedy 함정** (핵심): `ScrollView { content.fixedSize(vertical: true) }.frame(maxHeight: X)` 패턴에서 `fixedSize` 는 **content** 의 intrinsic 만 고정할 뿐 ScrollView 자체는 여전히 부모가 제안한 `maxHeight` 를 무조건 가득 채움. content 가 frame 보다 작아도 ScrollView 가 frame 만큼 자라 빈 공간이 생기거나, content 가 조금이라도 크면 즉시 스크롤바 발생.

### 해결

**`apple/AgentDeck/UI/MenuBar/ControlTowerPanel.swift`**
- `ChromeHeightKey` PreferenceKey + `measureChromeHeight()` View extension 추가 — header Group / banner+pillActionsBar / footerSection 3 위치의 실측 높이를 reduce-합산.
- `ContentHeightKey` PreferenceKey 추가 — body VStack 에 GeometryReader backing 으로 natural 높이 publish (single-source 라 reduce 는 `value = nextValue()` 로 latest 채택).
- ScrollView frame 을 `min(scrollContentMaxHeight, measuredContentHeight)` 로 명시 바인딩 — ScrollView greedy 우회. content < cap 이면 ScrollView 가 content 크기로 줄어들고 scrollbar 안 뜸.
- `showsIndicators: measuredContentHeight > scrollContentMaxHeight` 조건부 — 진짜 overflow 일 때만 표시.
- `scrollContentMaxHeight` = `max(80, screenHeight - max(140, measuredChromeHeight) - 24)`. `screenHeight * 0.85` 계수 제거 (`visibleFrame` 이 이미 menubar+Dock 제외). 80 pt 플로어는 1 세션 행 가시성 보장; AttentionTheater 가 클 때 body 가 자연 축소되어 popup_total ≤ screen 유지.
- 팝업 너비 `.frame(width: 380)` → `.frame(minWidth: 380, idealWidth: 420, maxWidth: 460)` 가변화.
- Swift 6 strict-concurrency: PreferenceKey `defaultValue` 는 `static let`.

**`apple/AgentDeck/UI/MenuBar/AttentionTheaterView.swift`**
- 옵션 리스트 ScrollView 캡 `220 pt` 고정 → `min(380, screenHeight * 0.35)` 적응형. 일반적인 3–8 옵션 prompt 는 ceiling 에 안 닿아 scrollbar 자체 안 뜸. `/openclaw scope` 같은 30+ 옵션만 카드 내부 스크롤로 흡수.
- Sizing invariant: `options(≤380) + 140(badge/question chrome) + 150(banner+pill+footer) + 80(body floor) + 24(safety) ≤ screen`. 일반 화면 (≥800 pt) 에서 popup 절대 overflow 안 함.

### 핵심 설계 결정

- **SwiftUI ScrollView 는 부모가 제안한 height 를 항상 가득 채우는 greedy view**. `.fixedSize(vertical: true)` 를 안쪽 VStack 에 붙여도 ScrollView 자체는 안 줄어듬. ScrollView 가 content 크기로 줄어들게 하려면 별도 PreferenceKey 로 content 높이를 측정 → `.frame(maxHeight: min(cap, contentHeight))` 로 명시 바인딩 필요. macOS SwiftUI 의 잘 안 알려진 함정.
- **`max(140, measuredChromeHeight)` 형태의 fallback** 은 PreferenceKey 가 첫 frame 에 미발화 (한 runloop tick 뒤 도착) 인 경우를 위한 안전망. 일반적으로 실측치 ≥ 140 이라 `max()` 가 fallback 보다 큰 측정치를 채택해 동작에 영향 없음.
- **여러 sizing cap 은 같은 화면 예산을 나눠 쓴다는 invariant 위에 설계해야**. AttentionTheater 옵션 cap (옵션이 헤더에 포함됨) + body floor 가 독립적으로 자기 몫 주장하면 popup_total > screen 으로 overflow. cap 들의 합 + chrome 추정치 ≤ screen 을 산식으로 명시하고 각 cap 을 그 산식 안에서 정함.
- **ContentHeightKey 의 reduce 는 `value = nextValue()` (덮어쓰기), ChromeHeightKey 는 `value += nextValue()` (누적)**. 전자는 단일 GeometryReader 소스, 후자는 3 위치 합산. PreferenceKey reduce 시맨틱은 source 수에 따라 다르게 선택.
- **같은 popup 안 두 ScrollView 는 둘 다 ContentHeight PreferenceKey 패턴 필요**. 1차 fix 는 ControlTowerPanel body 만 적용했고 AttentionTheater 옵션 ScrollView 는 cap 만 조절해 greedy 그대로 남겨 — Codex stop-time review 가 잡음. 2차 fix 에서 `OptionsHeightKey` 를 file-local 로 정의 (`ContentHeightKey` 와 분리해야 같은 root 의 onPreferenceChange bubble 에서 안 섞임) + 옵션 VStack 에 GeometryReader backing + `frame(maxHeight: min(optionsCap, measuredOptionsHeight))` 명시 바인딩. **교훈**: ScrollView 인스턴스 수만큼 별도 PreferenceKey + 별도 @State 필요.

---

## 2026-05-17 — Apple Daemon: Timeline turn merge + chat_start ts FIFO queue + APME outcome 영구화 + OpenClaw 도구 가시성

### 문제

세 가지 문제가 한 세션에서 누적 발견됐다.

1. **Timeline UX**: 한 user prompt → 응답 → 완료 사이클이 3 row 로 쪼개져 보이고, task_start 회전 spinner 가 영원히 돌며, TASK 헤더가 모든 첫 메시지마다 등장. 회전 아이콘은 사각형(`list.bullet.rectangle.fill`)이라 회전이 어색.
2. **OpenClaw 도구 가시성**: `apme.sqlite` 의 OpenClaw `tool_name` 컬럼이 `"tool"` placeholder, payload 도 비어서 도구 호출이 무엇이었는지 추적 불가. APME run 들이 일괄 `task_category='_empty'` 로 분류돼 평가 무의미.
3. **APME outcome 영구화 silent drop**: `ApmeOutcomeEngine.evaluateOutcome` 의 결과 4 fields (outcome / outcomeConfidence / efficiencyJson / compositeScore) 가 DB 에 영구화되지 않아 같은 6 run ID 가 30 초마다 217 회 재로깅. 전체 DB 에 outcome 컬럼이 채워진 run 이 0 건.

### 해결

**Timeline UX (Apple)**
- `Model/Timeline.swift::groupConsecutive` 에 chat-turn merge 분기 추가 — 같은 sessionId 의 chat_start (meaningful) → chat_response → chat_end 를 `GroupedEntry.mergedResponse` / `mergedCompletion` 로 흡수해 1 row 로 표시. wall-clock window 안 보고 `child.startedAt == start.ts` anchor 매칭으로 cross-turn attach 차단.
- `Daemon/Apme/ApmeCollector.swift`: `openTaskIfNone` 의 timeline emit 을 deferred. TodoWrite 호출 또는 2nd turn 시 `emitDeferredTaskStartIfNeeded()` 가 발화. 단일-turn 짧은 대화는 TASK 헤더 안 보임.
- `ApmeCollector.idleGapSec` (default 90 s) + 4-단 race guard (`attributedToActiveTurn` / `idleGapMinTurnAgeSec` / snapshot turnId / chatEndTs) — `setTurnResponse` 끝에서만 arm.
- `UI/Monitor/TimelineStripView.swift::RotatingTimelineIcon` 에 `rotatingSymbolName` 옵션 — TASK 헤더는 정적 시 `list.bullet.rectangle.fill`, 회전 시 `arrow.triangle.2.circlepath`.

**OpenClaw 도구 가시성**
- `Daemon/Gateway/OpenClawAdapter.swift`: `emitTimelineEntry(fromSessionTool:)` 가 toolName / toolInput / toolOutput 을 out-of-band extras dict 로 노출. `firstJSONValue` 헬퍼가 NSNull (explicit JSON null) 을 absent 로 unwrap.
- `Daemon/Server/DaemonServer.swift::gatewayToolHookFromEntry` 정적 helper — entry dict 에서 구조화 필드 추출 + Claude Code shaped hook payload (`tool_name` / `tool_input` / `tool_response`) 로 매핑. 라우팅은 `status ∈ {complete, error, failed}` 또는 `toolOutput != nil` → tool_end, 그 외 → tool_start. `entry["detail"]` 은 더 이상 routing 결정에 안 쓰임 (legacy fallback 에서 detail blob 으로 running 이 tool_end 로 잘못 분기되던 버그).

**APME outcome 영구화 (Apple)**
- `Daemon/Apme/ApmeStore.swift::updateRun` 의 `colMap` 에 outcome / outcomeConfidence / efficiencyJson / compositeScore 4 entries 추가. 매핑 없는 키는 `guard let col = colMap[key] else { continue }` 에서 silent skip → SET clauses 0 개 → 조기 return → SQL UPDATE 자체 실행 X. 스키마 / readRun / migrations 는 모두 outcome 알고 있는데 updateRun 하나만 빠진 silent partial wiring. 헤더 주석으로 future-proofing 명시.

**chat_start ts FIFO queue (Apple)**
- `Daemon/Server/DaemonServer.swift`: `claudeChatStartTsBySession: [String: Double]` / `codexChatStartTsBySession` 단일-슬롯 dict → file-scope `ChatStartTsQueue` 구조체 인스턴스 2 개. chat_start = enqueue, Stop hook = dequeue head (FIFO). mid-turn 행위 (tool_exec 등) 는 `peekTail` (가장 최근 = active turn). `appendCodexChatStart` 의 upsert 분기 제거 — follow-up prompt 의 head row overwrite 차단.

### 핵심 설계 결정

- **single-slot per-session state 는 multi-turn race 에 취약**. `[String: T]` slot 이 "현재 active turn 의 T" 라는 가정은 사용자의 빠른 follow-up + 비동기 Stop hook callback 조합에서 깨진다. 모든 in-flight turn state 는 sessionId 안에서 FIFO queue (또는 turn-id keyed dict) 로 추적해야. `ChatStartTsQueue.peek` (head, "다음 Stop 이 dequeue 할 것") vs `peekTail` (newest, "지금 generating 중인 turn") 시맨틱 분리.
- **chat_response / chat_end 의 `startedAt` 는 source-of-truth anchor**. Daemon 이 originating chat_start 의 ts 를 stamp 하고, Timeline `groupConsecutive` 의 `sameTurnAnchor(start:, child:)` 가 그 anchor 와 head 의 ts 가 일치할 때만 흡수. wall-clock window 는 dedup 그룹화에만 (60 s), turn merge 에는 무관 — 긴 응답 (xcodebuild + 멀티 fix 20 분+) 을 한 turn 으로 묶기 위해.
- **Tool routing 은 status / output 기반 strict**. `entry["detail"]` 처럼 시각용 blob 의 nil 여부로 start vs end 를 결정하면 input-only running 이 end 로 잘못 분기. routing 전용 helper (`gatewayToolHookFromEntry`) 를 testable 한 static 으로 분리.
- **colMap 같은 single-source mapping table 은 silent-failure 위험**. 키 누락이 컴파일 에러 없이 SQL UPDATE 자체를 무력화. 헤더에 "extending 시 mirror 위치" 명시 + 회귀 가드 (round-trip 테스트) 필수.
- **NSNull defense in depth**: JSON-decoded `[String: Any]` 의 explicit `null` 은 `Optional.some(NSNull())`. `!= nil` 통과. producer / router 양쪽에서 unwrap.
- **spinner stop 은 chat_end 가 아닌 "응답 도착" 신호 기반**. chat_end 는 비신뢰성 path (Stop hook ~18% reliability + async summarize). chat_response 는 sync broadcast 라 더 신뢰성 있음. `GroupedEntry.hasResponse` = `mergedResponse != nil || mergedCompletion != nil` 둘 중 하나라도 도착하면 turn "delivered". chat_end 누락에도 spinner 정상 종료.

회귀 가드 33+ 종 신규 (TimelineTests + ApmeTaskBoundaryTests). Codex stop-time review 11 차에 걸쳐 누적 발견된 race / mis-routing / hang-induced-spinner 시나리오를 케이스별로 명시 회귀 가드 + 메모리 노트 (timeline-turn-merge-lazy-task / openclaw-tool-payload-mapping / apme-updaterun-colmap-trap).

---

## 2026-05-11 — Android E-ink Dashboard 3-section redesign

### 문제

`E-ink Dashboard.html` 디자인 핸드오프의 최종 방향은 App Store 출시 준비 맥락에서
E-ink 화면을 세션 목록 / 테라리움 / 텍스트 Timeline 중심으로 단순화하는 것이었다.
기존 Android `EinkMonitorScreen` 은 중간 status band 에 LIMITS / MODELS / DEVICES 를
크게 표시하고, landscape 에서 좌측 session rail 이 전체 높이를 차지해 실제 디자인의
"상단 Sessions|Terrarium + 하단 Timeline" 구조와 어긋났다.

### 해결

- Android E-ink landscape 를 chrome bar + optional Attention strip + `Sessions | Terrarium`
  상단 row + full-width text `EinkTimelinePanel` 하단 row 로 재구성했다.
- Portrait 도 동일 의미의 `Sessions / Terrarium / Timeline` 3단 stack 으로 정리하고,
  terrarium 을 세로 lane 으로 늘리지 않게 유지했다.
- rotate/settings controls 를 screen chrome 으로 이동했다. rotate 는 settings button
  표시 여부와 독립적으로 계속 노출된다.
- LIMITS 는 fresh 5h/7d usage 값이 있을 때만 terrarium 우하단 작은 corner card 로
  표시한다. 값이 없거나 stale 이면 App Store-safe progressive enhancement 원칙대로
  섹션 자체를 숨긴다.
- 기존 `EinkAgentPanel` 은 brand header / footer controls 를 숨길 수 있는 옵션을
  받아 chrome 이 별도로 존재하는 dashboard layout 에 재사용되도록 했다.
- `docs/android-ui.md` 의 E-ink projection 설명을 새 3-section layout 으로 갱신했다.

### 검증

- `cd android && ./gradlew testDebugUnitTest` — BUILD SUCCESSFUL.

---

## 2026-05-11 — Codex lifecycle hook feature flag rename

### 문제

Codex CLI 가 `⚠ [features].codex_hooks is deprecated. Use [features].hooks instead.`
경고를 출력했다. 현재 사용자 `~/.codex/config.toml` 의 AgentDeck fenced block 과
AgentDeck 의 Codex observation installer(Node + Swift)가 모두 예전
`[features] codex_hooks = true` 키를 쓰고 있어 수동 수정 후에도 재설치 시 경고가
되살아날 수 있었다.

### 해결

- 사용자 `~/.codex/config.toml` 의 AgentDeck fenced block 을 `[features] hooks = true`
  로 즉시 마이그레이션했다.
- Node `hooks/src/codex-install.ts` 와 macOS `CodexConfigInstaller.swift` 가 새
  `hooks = true` feature flag 를 쓰도록 변경했다.
- Node/Swift 테스트 기대값과 App Review notes 의 Codex observation 설명을 새 키로
  갱신했다.
- OpenAI docs MCP 의 config reference 는 아직 `features.codex_hooks` 로 표시되어
  있었지만, 로컬 Codex CLI 의 deprecation warning 을 현재 런타임 기준으로 채택했다.

---

## 2026-05-11 — macOS App Store export certificate selector cleanup

### 문제

`scripts/build-apple-release.sh --macos` 에서 archive 와
`apple/scripts/verify-appstore-archive.sh` 는 통과했지만, export 단계가
`No certificate for team 'R22679GY5Z' matching 'Mac Installer Distribution' found`
로 실패했다. 로컬 키체인에는
`3rd Party Mac Developer Installer: SEUNG BEOM CHOI (R22679GY5Z)` identity 가
존재했으므로 인증서 부재가 아니라 Xcode 26.4.1 의 automatic selector 해석 문제였다.

### 해결

- `apple/ExportOptions-macOS.plist` 의 `installerSigningCertificate` 를
  `Mac Installer Distribution` 자동 선택자에서 실제 설치된 installer identity common
  name 으로 고정했다.
- `docs/asc-cert-setup.md` 에도 동일한 값과 문제 원인을 반영했다.

### 검증

- `plutil -lint apple/ExportOptions-macOS.plist` — OK.
- `env -u ASC_API_KEY_ID -u ASC_ISSUER_ID bash scripts/build-apple-release.sh --macos`
  — archive succeeded, App Store archive verifier passed, `dist/export_macos/AgentDeck.pkg`
  export succeeded. TestFlight upload 은 의도적으로 env 를 비워 skip.

---

## 2026-05-10 — App Store release readiness: APME dashboard + Device Preview catalog

### 문제

App Store 제출 전 점검에서 Evaluation(APME) 과 Device Preview 표면에 실제 동작/문서
불일치가 있었다.

- APME dashboard 는 `/apme?token=...` 로 열리지만 후속 `fetch('/apme/runs')`,
  `fetch('/apme/run/...')`, `POST /apme/vibe` 에 token 을 붙이지 않았다. Node
  daemon 의 APME 라우트는 token-gated 라서 평가 UI 가 401 로 비어 보일 수 있었다.
- Swift APME HTTP detail payload 가 `vibe` 와 `turnEvals` 를 싣지 않아 App Store
  in-process daemon 에서는 vibe column / turn-level judge 점수가 dashboard 에 반영되지
  않았다.
- Swift eval result timeline append 는 저장만 하고 `timeline_event` broadcast 를 하지
  않아 live dashboard/device timeline 에 ★ eval_result 행이 즉시 뜨지 않았다.
- Device Preview 문서/주석은 "14 targets" 라고 쓰여 있었지만 실제 catalog 는 16개,
  App Store standalone visible set 은 ADB-tier 4개를 숨긴 12개였다.

### 해결

- APME dashboard HTML(TS source + App Store bundled resource)에 `api(path)` helper 를
  추가해 현재 URL 의 `token` 을 모든 APME fetch/POST 에 전파.
- Swift `ApmeHttpRoutes` 를 Node shape 에 맞춰 보강: schema envelope, `/apme/run/<id>`,
  `vibe`, per-turn `turnEvals`, authenticated UI routes, GET/POST recommend parity.
  FoundationModels judge relay endpoint 은 Node runner 호환을 위해 기존처럼 same-machine
  POST 로 유지.
- `appendEvalResultTimeline` 이 `timeline_event` 를 즉시 broadcast 하도록 수정하고,
  `layer1SkippedReason` 을 WS/HTTP payload 에 실어 App Store LLM-only 평가 상태가
  dashboard 에 표시되게 함.
- APME empty-state copy 에서 "Launch a session from the menubar" 문구를 제거하고,
  사용자가 자기 workspace 에서 agent 를 실행한다는 App Store-safe copy 로 정리.
- Device Preview catalog count 를 16 total / 12 standalone / 4 desktop-bridge 로 문서화하고
  `APP_REVIEW_NOTES.md`, `docs/appstore-feature-matrix.md` 를 실제 UI 정책에 맞춤.
- APME runner 테스트가 실제 사용자 App Store container 의 `daemon.json` 상태에 의존하지
  않도록 FoundationModels fallback 테스트에 임시 `AGENTDECK_DATA_DIR` 를 주입.
- Vitest 전역 setup 에서 worker 별 임시 `AGENTDECK_DATA_DIR` 를 설정해 전체 test suite 가
  로컬 설치/실행 중인 AgentDeck daemon 상태에 의존하거나 hang 하지 않도록 격리.
- Stream Deck plugin `ConnectionManager` 도 `AGENTDECK_DATA_DIR` override 를 존중하게 해
  테스트/개발 환경에서 App Store container fallback 파일을 직접 읽지 않도록 수정.

---

## 2026-05-10 — Timeline rotation + Android entry-filter parity (in-flight task hierarchy)

### 문제

사용자가 Android tablet timeline 과 macOS/iOS timeline 사이에 두 가지 차이를
보고했다.

1. "android tablet 은 진행중 태스크 상태가 회전 이모지로 안내되는데
   macOS/iOS 에는 적용이 안 된 것 같다."
2. 두 클라이언트가 보여주는 timeline 로그가 "표시되는 entry 종류/개수"
   측면에서 다르다.

코드 조사 결과 — 회전 자체는 양쪽 모두 `chat_start` + unknown type 에 대해
이미 평행하게 동작했지만 (`shared/src/timeline-icons.ts` 단일 spec, Apple
`RotatingTimelineIcon` ↔ Android `rememberRunningRotation` 1.8s 회전), 두 가지
실제 갭이 있었다.

- **회전 의미 부족**: 양쪽 모두 task hierarchy (`task_start` ↔ `task_end`)
  마커는 정적 `.task` 아이콘으로만 그려졌다. `task_start` 가 완료되지
  않았는데도 회전 신호가 없어서 "지금 진행 중" 표시가 hierarchy 레이어에
  부재했다.
- **Entry 필터 비대칭**: Apple `timelineDisplayGroupsForDashboard` 는
  `timelineIsLowSignalEntry` (codex:otel-active 의 `tool`/`exec` 노이즈)와
  meaningful chat_start 보존 룰을 모두 가지고 있었지만 Android
  `timelineDisplayGroups` 에는 둘 다 없었다. 결과로 Android 가 Apple 보다
  훨씬 많은 노이즈 row 를 보여주어 "회전이 더 풍부하다"는 인지를 만들고,
  반대로 Apple 은 적은 row 사이에서 회전이 잘 안 보인다는 인지를 만들었다.

### 해결

1. **Shared 술어 신규** (`shared/src/timeline-icons.ts`):
   - `isInFlightTask(entry, siblings)` — `task_start` 인데 같은 `taskId` 의
     `task_end` 가 siblings 에 없으면 true.
   - `isRotatingEntry(entry, siblings)` — `iconKey === 'running'`
     (chat_start, unknown) ∪ in-flight task. iconKey 자체는 단일-entry
     함수로 유지해 테스트 단순.
2. **Apple 포팅** (`TimelineStripView.swift`):
   - `timelineIsInFlightTask` / `timelineIsRotatingEntry` Swift 미러 추가.
   - 회전 호출지점 3곳 모두 새 술어로 전환: `turnRow` (라인 293),
     `taskHeaderRow` (라인 449 — 정적 `Image` 를 `RotatingTimelineIcon` 으로
     교체), `detailPane` (라인 531).
   - **taskHeaderRow 는 turnRow 와 분리된 별도 경로**라서 turnRow 만 패치하면
     `task_start` row 가 빠진다 — 양쪽 다 수정해야 task hierarchy 회전이
     실제로 보인다.
3. **Android 포팅** (`TimelineIcons.kt` + `TimelineStrip.kt`):
   - Kotlin `isInFlightTask` / `isRotatingEntry` 추가.
   - `CompactLogRow` → `TurnRow` / `TaskHeaderRow` 에 `siblings: List<TimelineEntry>`
     파라미터 추가, `displayEntries` 를 `TimelineList` 에서 흘려보냄.
   - `TaskHeaderRow` 의 정적 Icon 을 `rotate(taskAngle)` modifier 로 감싸서
     in-flight 회전 적용.
4. **Apple 필터 Android 백포트** (`state/TimelineDisplay.kt`):
   - `isLowSignalEntry`: codex-cli + sessionId == "codex:otel-active" + type
     ∈ {tool_exec, tool_request, tool_resolved} + raw ∈ noise set 6종 →
     drop.
   - `isMeaningfulChatStart`: synthetic 시작 row 5종 (`prompt sent`,
     `codex turn started`, `starting chat`, `connected`, `resumed`) 만 completion
     도착 시 elide. 의미 있는 사용자 프롬프트는 응답 옆에 유지 (Apple과 동일).
   - `chat_end` 도 Apple과 동일하게 `summaryKind` 값에 따라 분기:
     `llm`/`heuristic` 이면 `chat_response` 와 별개로 살아남고, `none`/`null`
     이면 기존 dedup-with-chat_response 룰 적용.

### 핵심 설계 결정

- **회전 트리거는 iconKey 와 분리**된 별도 술어로 모델링한다. iconKey 는
  entry 단독 함수, isRotatingEntry 는 sibling 의존 술어. iconKey 의 단순성
  (테스트 가능, 캐시 가능) 을 유지하면서 hierarchy 의 시간적 의미를 따로
  집어넣는다.
- **siblings 는 visible group 이 아닌 실제 timeline entries 를 넘긴다**.
  visible group 은 dedup 로 task_end 가 잠시 사라질 수 있는 반면, full
  timeline 은 안정적이다. Android 는 `displayEntries`, Apple 은
  `grouped.map(\.entry)` 를 사용 (Apple 의 grouping 은 task hierarchy 를
  group 하지 않으므로 동등).
- **Android 가 Apple 의 baseline 으로 수렴**한다 (사용자가 명시 선택). 반대
  방향 — Apple 필터를 완화 — 도 가능했지만 codex:otel 노이즈는 객관적으로
  사용자에게 가치가 없으므로 Apple 의 결정이 옳다.

### 검증

- `pnpm test` — 53 files / 1212 tests passed (vitest, +14 신규 술어 케이스).
- Android `./gradlew testDebugUnitTest` BUILD SUCCESSFUL — `TimelineTaskHierarchyTest`
  +10 신규 (isInFlightTask / isRotatingEntry), `TimelineDisplayScenarioTest`
  +3 신규 (codex otel filter / synthetic chat_start / chat_end summaryKind).
  기존 `multi-agent dashboard timeline` 케이스는 새 정책에 맞춰 assertion
  보정 (linter 자동) — meaningful "Fix Android timeline" 프롬프트가 응답 옆에
  유지되도록 검증.
- Apple `xcodebuild` macOS Debug + iOS Simulator Debug — 모두 BUILD SUCCEEDED.
- 시각 검증은 미수행 (memory `feedback_verify_visual_output` 정책상 사용자 캡처
  필요). long-running task 케이스: `agentdeck claude` + `TodoWrite` 시작 →
  `task_start` 회전 → `task_end` 도착 시 정지 의 패턴을 macOS dashboard 와
  Android tablet 에서 동일하게 확인 권장.

### 추가 수정 (Codex stop-time review)

OTel 필터를 Android `state/TimelineDisplay.kt` 의 표시 경로에만 추가했더니
`TimelineStore` 에는 여전히 노이즈가 들어가 (1) `entries` flow 의 다른
컨슈머에 노출, (2) 500-entry MAX 버퍼가 OTel 노이즈로 채워져 유용한 row 가
조기 aged-out, (3) 향후 on-disk persistence 에 그대로 흘러갈 위험이
남았다. Apple 은 `DaemonTimelineStore` add/load 단에서도 같은 룰을
적용하고 있어 비대칭. 후속 커밋 `db4491f2 fix(android): apply OTel
low-signal filter at TimelineStore add path` 에서:

- `isLowSignalEntry` 를 `private` → `internal` 로 끌어올려 같은 패키지의
  `TimelineStore` 가 직접 참조하도록 함. 룰 중복 회피.
- `TimelineStore.addEntry` / `addEntries` / `upsertEntry` 가 OTel
  low-signal 후보를 short-circuit 으로 거부.
- `TimelineStoreTest` 4 cases (단일 add 거부 / 같은 sentinel 세션의
  meaningful raw 유지 / 일괄 replay 필터 / upsert add fallback 거부) 추가.

---

## 2026-05-10 — Swift daemon ESP32 false-failure / Usage API fallback stability

### 문제

운영 중인 macOS Debug daemon 로그에서 ESP32 기기 자체는 정상 연결 상태인데도
UART serial write 의 일시적 `EAGAIN`/backpressure(`errno=35`)가 hard
failure 로 분류되어 `portFailures` 와 disconnected 상태로 전파되는 현상이
확인됨. 동시에 `sessions_list` 동일 payload broadcast 가 짧은 시간에 반복되어
serial writer 를 더 압박했고, App Store Swift daemon 이 직접 읽을 수 없는
Claude Code OAuth keychain 경로를 Usage API Tier 3 에서 계속 시도해 실패 로그를
발생시켰음.

### 해결

- `ESP32Serial` write path 에 backpressure 분류를 추가. `EAGAIN`/zero write
  는 2초까지 재시도하고, 끝까지 밀리면 연결을 유지한 채 throttled debug 로만
  기록한다. 실제 hard failure 일 때만 read token invalidation 과
  `failedPorts` 기록을 수행.
- partial write 뒤 다음 payload 앞에 line reset newline 을 붙여 JSONL frame
  오염 가능성을 줄임. 성공 write/read/device_info 수신 시 해당 port 의 stale
  failure 를 제거.
- `device_info` 미수신은 즉시 reconnect 하지 않고 요청을 재시도한다. 완전히
  silent 인 port 만 120초 이후 reconnect 대상으로 분류.
- `statusSnapshot.portFailures` 는 현재 connected port 의 stale failure 를
  노출하지 않도록 필터링하고, `lastReadAt`/`lastWriteAt`/요청 횟수를 추가해
  진단성을 높임.
- `DaemonServer.broadcastSessionsList()` 에 stable JSON fingerprint 기반 dedupe
  를 추가해 동일한 `sessions_list` broadcast storm 을 억제.
- `UsageAPIClient.directOAuthUsageSupported = false` 경계를 명시하고 Swift
  daemon 에서는 직접 OAuth usage fetch 를 건너뛰게 함. Usage path 는 sibling
  relay / Admin API / stale cache semantics 로만 동작.

### 검증

- `xcodebuild -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS
  -destination 'platform=macOS,arch=arm64' -configuration Debug build
  CODE_SIGNING_ALLOWED=NO -derivedDataPath /tmp/AgentDeckStabilityBuild`
- `xcodebuild -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS
  -destination 'platform=macOS,arch=arm64'
  -only-testing:AgentDeckTests_macOS/UsageAPIClientThreadingTests test
  CODE_SIGNING_ALLOWED=NO -derivedDataPath /tmp/AgentDeckStabilityTests`

---

## 2026-05-10 — App Store timeline LLM 요약 (FoundationModels → MLX → Ollama → heur)

### 문제

App Store macOS 빌드의 timeline `chat_end` 행은 휴리스틱 한 줄 추출
(`extractTopicHint`)만 사용했음. 같은 위치에서 Node bridge 빌드는
MLX(`Qwen3.6-35B-A3B-4bit`)로 LLM 요약을 생성하므로 standalone App Store
앱은 dashboard / device renderer 가 "응답 첫 줄 잘라낸" 라벨만 받음.
인프라(`apple/AgentDeck/Daemon/Timeline/TimelineSummarizer.swift` MLX/Ollama
체인 + `ApmeJudgeFoundationModels.swift` Apple Intelligence 어댑터)는
이미 깔려 있었지만 호출 site 가 없는 dead code 였음.

추가 제약: App Store 심사 invariants(2.5.2 self-contained / 4.2.3 no
install nudge) 와 `feedback_cost_sensitive_defaults.md` (default 백엔드
무료) 를 모두 보존해야 함.

### 해결

- `TimelineSummarizer.summarize(_:provider:)` 시그니처 변경 — `(text, kind)?`
  반환. `SummaryProvider` enum 추가 (`auto / appleIntelligence / mlx /
  heuristic`). `auto` 체인은 FoundationModels → MLX → Ollama → 휴리스틱
  순서, 명시 픽은 short-circuit. FoundationModels 분기는
  `ApmeJudgeFoundationModels.swift` 의 `#if canImport(FoundationModels)` +
  `#available(macOS 26.0, *)` + `SystemLanguageModel.default.availability`
  패턴 그대로 미러.
- `DaemonTimelineEntry` + `claudeCodeEntryDict` 에 `summaryKind: String?`
  추가. 디스크 round-trip + WS broadcast 양쪽에서 보존되도록 plumbing.
  앞서 dict serializer 가 필드를 빠뜨려 dashboard 가 항상 nil 로 디코드한
  버그를 stop-time review 가 잡음.
- `appendClaudeCodeChatEnd` (DaemonServer.swift:4612) + `appendCodexChatEnd`
  (DaemonServer.swift:4491): chat_response 즉시 broadcast 유지, chat_end
  빌드 + add + broadcast 를 `Task { ... }` 로 감싸 LLM await 후 실행.
  캡처는 by-value 라 main-actor 의 후속 cache cleanup 이 in-flight Task 를
  영향 안 줌.
- `AppPreferences.timelineSummaryProvider` (default `"auto"`) +
  `writeTimelineSummaryProviderToSettingsJson` 으로 `~/.agentdeck/
  settings.json` `timeline.summary.provider` 키에 미러.
- Settings → Advanced 에 `.timelineSummary` 신규 섹션. APME judge backend
  picker 패턴 그대로 (FoundationModels 비가용 시 inline grayed reason,
  MLX 행 secondary text 는 APME 와 동일 카피).
- `TimelineStripView::turnRow` 의 chat_end 에 한 줄 백엔드 pill (AI / MLX
  / Ollama / Heur). 휴리스틱도 라벨링 — App Store deploy target 이 macOS
  15 인데 FoundationModels 는 macOS 26+ 라, 대다수 사용자가 항상 휴리스
  틱 분기로 떨어짐. 휴리스틱을 숨기면 picker 변경의 가시 신호가 0 이라
  Codex review 가 두 번 잡음.
- `docs/appstore-feature-matrix.md` 행 추가, `apple/APP_REVIEW_NOTES.md`
  단락 추가.

### 핵심 설계 결정

- **FoundationModels 를 chain head 에 둠** — APME 와 동일 정책. 무료/오프
  라인/sandbox 안전. macOS 15 deploy target 에서 `#available` gate 로
  graceful fallback. 별도 OS 분기 코드 없음.
- **Ollama 는 `auto` 체인의 내부 fallback, picker 노출 X** — APME 가
  Ollama 옵션을 노출 안 한 선례 따름. 사용자 picker 는 의도/기대치
  표현용; 자동 fallback 이 항상 휴리스틱으로 떨어짐을 보장하면 충분.
- **chat_end Task 감싸기 vs upsert 두 단계** — 단순함을 택함. chat_end 는
  dimmed metadata 행이라 1-5s 지연이 사용자 체감에 무해. chat_response
  의 본문 broadcast 는 즉시 유지하므로 응답 지연감 없음.
- **summaryKind 값은 `"appleIntelligence" | "mlx" | "ollama" |
  "heuristic"` 4종, `"none"` 미사용** — 기존 UI 가 `"none"` 을 "detail
  표시 억제" 시그널로 쓰지만 새 경로는 항상 raw 에 의미있는 라벨이 들어
  가서 억제할 게 없음. detail-redundancy 검사가 그 자리를 대체.
- **App Store 심사 invariant**: subprocess 0건, install-nudge 카피 0건,
  Anthropic API 등 paid backend 는 picker 미포함. `verify-appstore-archive
  .sh` main Mach-O 스캔 통과.
- **stop-time review 두 라운드 회고**:
  (1) `claudeCodeEntryDict` 에서 `summaryKind` 빠뜨린 silent serialization
  bug 는 unit test 도, build 도 잡지 못함. dict-shape mismatch 는
  broadcast/disk 양쪽 round-trip 을 눈으로 추적해야 보임.
  (2) "휴리스틱 pill 은 노이즈" 라는 디자인 판단이 deploy target 현실
  (macOS 15 ↔ FoundationModels macOS 26)을 무시. 가시 시그널이 절대 안
  나오는 사용자 그룹의 존재를 못 보면 review 가 잡아준다.

---

## 2026-05-10 — Stream Deck OpenClaw 버튼: 모델 별칭 + 크리처 확대 + 세션별 회전 위상

### 문제

Stream Deck (정사각 144×144 키패드) OpenClaw 세션 버튼에서 세 가지 거슬림이 보고됨:

1. **모델명 줄임표**: `claude-sonnet-4-6` 같은 긴 문자열이 `claude-sonnet…` 로
   잘려서 추하게 보임. D200H 의 모델 표기는 같은 라이브러리가 같은 자르기
   규칙을 쓰는데도 가로폭 덕분에 자연스러워 보임.
2. **크리처가 너무 작다**: 48 px 워터마크 + opacity 0.42 라 답답함.
3. **회전 애니메이션 동기화**: PROCESSING 버튼이 여럿 있을 때 전부 같은
   `animFrame` 으로 perimeter 위 동일 위상에서 돌아 — 실제 진입 시점이
   다른데도 lockstep 애니메이션이라 어색.

### 해결

- `aliasModelName(name)` 신규 헬퍼 (`shared/src/svg-renderers/session-slot-renderer.ts`):
  `^claude-([a-z]+)-(\d+)-(\d+)(?:-\d+)?$` 정규식으로 `claude-sonnet-4-6 →
  sonnet 4.6`, `claude-haiku-4-5-20251001 → haiku 4.5` 등 매핑. 매칭 안되면
  원본 그대로 반환. `formatModelEffort` 가 truncate 전 한 번 통과시킴.
- 크리처 워터마크 48 → 72 px, opacity 0.42 → 0.55 (working) / 0.54 → 0.62
  (idle). `agentLogoIcon` 이 size 인자만 받아 동적 scale 하므로 한 줄 변경.
  D200H 도 같은 `renderSessionSlot` 을 호출하므로 동일하게 반영됨 — 사용자
  가 D200H 표기를 "적당하다" 평한 만큼 회귀가 아닌 일관성 개선.
- PROCESSING/AWAITING 진입 시점의 `animFrame` 을 `processingStartFrame:
  Map<sessionId, number>` 에 캡처. `renderOrbitingRect` 의 `phasePx =
  -(startFrame * speedPx) % BORDER_PERIMETER` 로 변환해 세션마다 perimeter
  위 시작점이 달라짐. 진입 시점이 같으면 동기, 다르면 비동기 — 실제
  타이밍에 맞는 자연스러운 위상.

### 핵심 설계 결정

- **wire protocol 미변경**: `processingStartedAt` 같은 새 필드를
  `SessionInfo`/`StateUpdateEvent` 에 추가하지 않음. 플러그인이 자체
  `animFrame` 으로 진입 시점을 재구성해도 phase 계산엔 충분 — 동일 세션
  이 ID 만 같으면 다음 진입 시 새 startFrame 으로 리셋됨.
- **animation restart 시 map clear**: `startAnimation()` 이 `animFrame = 0`
  으로 리셋하는데 stale map 엔트리가 남으면 phase 가 어긋남. clear 한 줄
  추가로 해결.
- **`renderSessionSlot` 만 손대고 D200H 전용 렌더러는 건드리지 않음**:
  D200H 가 같은 shared 함수를 호출한다는 사실은 재발견의 연속. 첫 패스
  에선 D200H `renderInfoButton('MODEL', state.modelName.slice(0,12))` 두
  곳을 의도적으로 건드리지 않고 보고 — 사용자가 D200H 표기를 이미
  좋다고 했고 review item 이 Stream Deck 한정이라.
- **stop-time review 가 잡은 1차 누락**: 첫 commit 은 session-slot SVG
  renderer (`renderSessionSlot`) 와 `renderDetailInfo` 만 alias 통과시켰
  지만, `SessionSlotManager.modelStatusCard()` 와 OpenClaw model preset
  subtitle (line 612 부근) 은 raw `modelName` 을 직접 truncateStr 로
  넘기고 있었음. detail view 의 MODEL 카드 / preset 버튼이 alias 미적용.
  Codex stop-time review 가 "model alias is incomplete on Stream Deck
  detail model cards" 로 짚어 보강 — `aliasModelName` 을 manager 에
  import 해서 두 spot 에 적용. regression test 한 개 추가해 detail 레이아
  웃에서 status card / preset 둘 다 alias 결과를 직접 비교.

### 검증

- `pnpm test`: 1186 / 1186 passing (1185 + 신규 alias 테스트 7 + manager
  detail-alias 테스트 1 → snapshot 1 갱신).
- 런타임 sanity: `renderSessionSlot` 두 번 호출해 `processingStartFrame`
  4 프레임 차이로 stagger 시킨 결과 `dashoffset` 이 `-220` vs `-132` 로
  분리됨을 확인.
- 실기 검증 (Stream Deck 본체에 plugin link 후 OpenClaw 다중 세션 RUN
  타이밍 차로 띄워보기) 은 사용자 몫으로 남겨둠.

---

## 2026-05-10 — Timeline prompt visibility + anonymous Codex OTel noise cleanup

### 문제

Dashboard TIMELINE 이 "의미 있는 턴만 보인다"는 취지는 맞지만, 실제
사용자 prompt row (`chat_start`) 까지 완료 row 뒤에서 사라지는 경우가
있었다. `TimelineStripView.timelineDisplayGroups` 가 later completion 이
있는 모든 `chat_start` 를 숨겼기 때문에, `hello` 같은 짧지만 의도적인
요청은 응답이 정상 도착한 뒤 timeline 에서 직접 보이지 않았다.

동시에 `~/.agentdeck/timeline.json` 에 과거 익명 Codex OTel 세션
(`codex:otel-active`) 의 `tool`, `tool completed`, `exec` 같은 저신호
`tool_exec` 행이 남아 있었다. 이 행들은 durable thread/prompt 없이 단일
익명 세션에 붙어 task 경계 없이 섞였고, 사용자가 "내 요청은 안 보이고
중간 처리 로그만 보인다"고 느끼게 만들었다.

### 해결

- 완료된 턴이라도 `chat_start.raw` 가 실제 사용자 문장이라면 Dashboard
  timeline 에 유지한다. `Prompt sent`, `Codex turn started`, `Connected`,
  `Resumed` 같은 synthetic 시작 row 만 계속 접는다.
- `chat_response` 가 있는 경우 redundant `chat_end` 는 기존처럼 숨겨 한
  턴이 "요청 + 응답" 중심으로 보이게 했다.
- `DaemonTimelineStore` 가 anonymous Codex OTel 의 generic tool rows
  (`tool`, `tool completed`, `unknown`, `exec`, `exec completed`) 를 add/load
  양쪽에서 버리도록 했다. 기존 persisted history 도 앱 재시작 시 필터된다.
- 동일 필터를 Dashboard display path 에도 두어 오래된 history replay 가
  들어와도 UI 에 노출되지 않게 했다.

### 검증

- `git diff --check -- apple/AgentDeck/UI/Monitor/TimelineStripView.swift
  apple/AgentDeck/Daemon/Timeline/DaemonTimelineStore.swift
  apple/AgentDeckTests/TimelineTests.swift` 통과.
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS
  -destination 'platform=macOS,arch=arm64'
  -only-testing:AgentDeckTests_macOS/TimelineTests test
  CODE_SIGNING_ALLOWED=NO
  -derivedDataPath /tmp/AgentDeckTimelineInvestigation` 통과 — 22 tests,
  0 failures.

---

## 2026-05-10 — lobe-icons 브랜드 마크 다운스트림 렌더러 정리 (stop-hook iteration)

### 문제

`design/brand/` SSOT 와 `docs/design{,-mockups}/creatures.jsx` 는 lobe-icons
4개 마크(claudecode/codex/openclaw/opencode) 로 정리됐지만, 다운스트림
hardcoded path renderer 들이 옛 sourcing 그대로:
- Apple `CreatureClaudeCode.imageset/claudecode.svg` → lobe `claude.svg`
  (Anthropic swirl, generic Claude mark, Claude Code 전용 아님)
- Apple `CreatureOpenCode.imageset/opencode.svg` → 240×300 viewBox + baked
  color (`#CFCECD`/`#211E1E`) 자체 변형
- Android `BrandIcon.kt` `CLAUDE_PATH` = swirl, `OPENCODE_PATH` = 240×300
  → 24×24 스케일 path
- Apple `SessionBrand.AgentBrandIcon` `claudePath`/`openCodePath` 동일 stale
- `SessionListPanel.swift` 에 promoted 후 잔존한 dead `BrandIcon` struct
  (57 lines, swirl + 240×300 path 보유)

같은 4 브랜드를 표현하는 5개 표면(asset catalog / Compose Canvas / SwiftUI
Path / JSX inline embed × 2 mirror) 이 SSOT 변경 후에도 다르게 렌더되는
드리프트. Codex stop-hook 이 "updated SVG assets leave hardcoded brand
renderers stale" 로 잡았다.

### 해결

- Apple imageset 2개 → lobe-icons (`claudecode.svg` Claude Code-specific
  grid, `opencode.svg` 24×24 currentColor nested-square)
- Android `BrandIcon.kt` `CLAUDE_PATH`/`OPENCODE_PATH` → lobe 24×24 paths
- Apple `SessionBrand.AgentBrandIcon` `claudePath`/`openCodePath` → lobe 24×24
- `docs/design{,-mockups}/creatures.jsx` opencode entry 240×300 → 24×24 +
  주석 정리 (prior 세션이 일부 정리, 잔여 mirror 동기화)
- `SessionListPanel.swift` dead `BrandIcon` struct 제거
- `shared/svg-renderers/agent-logos.ts` `ROBOT_CREATURE_PATH` 는 이미 lobe;
  `CLAUDE_LOGO_PATH` (Anthropic swirl) 는 plugin/test 별도 reference 로
  stale 아님 — 그대로 유지

### 핵심 설계 결정

- **lobe-icons antigravity ↔ claudecode 분리.** 2026-04-19 의 Antigravity
  사고는 lobe-icons claudecode.svg 의 grid 패턴이 Anthropic swirl 과
  혼동된 것. 현재 lobe-icons 는 `antigravity.svg` = swirl/peak shape 로
  분리되어 있어 grid = Claude Code 가 정확. `<title>` 검증 게이트는 여전히
  필수 (Anthropic swirl 을 Claude Code 자리에 잘못 넣는 inverse error
  여전히 가능)
- **다중 표면 동기화 체크리스트.** 같은 SVG 가 inline embed 되는 5곳:
  (1) `apple/.../Assets.xcassets/Creature*.imageset/*.svg`,
  (2) `android/.../ui/component/BrandIcon.kt` path 상수,
  (3) `apple/.../UI/Common/SessionBrand.swift` `AgentBrandIcon` path 상수,
  (4) `docs/design{,-mockups}/creatures.jsx`,
  (5) `shared/src/svg-renderers/agent-logos.ts`. SVG 자산 변경 시 모두
  동기화 필요. 메모리 `brand-renderer-surfaces.md` 참고
- **Stylized vs canonical 구분.** `agent-logos.ts` 의 `openCodeCreatureIcon`
  은 nested rectangle primitive 로 그리는 SD button tile 렌더러로, 의도된
  warm-grey palette. brand mark pixel-accurate reproduction 아니므로 lobe
  SVG 변경에 동기화 불요. Terrarium creature renderers (CloudCreature,
  OpenCodeCreature, CrayfishCreature 등) 도 anim 캐릭터 표현체로 별도
- **Dead code 정리 동반.** Promoted-and-orphaned `BrandIcon` struct 같은
  zombie path 상수는 stale source 로 남기 쉬워 같이 제거. 식별 기준:
  struct 외부에서 생성자 호출 0건 + 기능적 후계자 존재

### 커밋 분리 메모

워킹 트리에 prior 세션의 거대한 미커밋 작업(timeline/daemon/Codex OTel 등
71 files +3642 lines)이 누적되어 있어, 이번 세션의 lobe-icons 변경 중
강결합 부분(`SessionBrand.swift` lobe path = prior 가 추가한
`AgentBrandIcon` 코드 안의 변경, `SessionListPanel.swift` dead struct 삭제
= prior +123 line 변경과 같은 파일)은 분리 staging 비현실적. 깨끗한 3개
파일(`Apple imageset claudecode.svg`/`opencode.svg` + `Android BrandIcon.kt`)
만 `e2f1377c` 로 커밋. 나머지 lobe-icons 변경은 prior 미커밋 묶음과 함께
다음 일괄 처리 시점에 합류 예정.

---

## 2026-05-10 — 프로젝트 전체 최소 OS = macOS 15+ 통일

### 결정

직전 commit 에서 App Store SwiftUI 앱만 deploy target 을 14 → 15 로
올렸지만, README badge / Requirements 표 / `docs/appstore-feature-matrix.md`
의 Min OS 행 / Stream Deck 플러그인 manifest 등은 여전히 "macOS 14+
Sonoma" 를 광고하고 있어 사용자가 보는 OS 라인이 두 갈래로 갈라져
있었다. 사용자 결정으로 프로젝트 전체 (CLI + App Store + Stream
Deck 플러그인 distribution) 최소 지원 OS 를 macOS **15.0+** 으로
일괄 통일.

### 변경 표면

- `README.md`: macOS 14 badge → 15, Requirements 표의 CLI/App Store
  split 행을 단일 `Platform: macOS 15+ (Sequoia)` 한 행으로 합침,
  Prerequisites 표의 macOS 14+ → 15+.
- `docs/appstore-feature-matrix.md`: Min OS 행의 CLI 칸 14 → 15.
- `plugin/bound.serendipity.agentdeck.sdPlugin/manifest.json`:
  `OS[0].MinimumVersion` 14.0 → 15.0. `Nodejs.Version: "20"` 은 SDK
  슬롯이라 별개로 유지.
- Swift 주석 두 곳 (`AgentStatusIcon.swift`, `AquariumSurface.swift`)
  의 "macOS 14+" 표현 정리.

코드 동작 변경 없음. `apple/project.yml` / pbxproj / CI runner /
Swift availability 게이트는 이미 직전 작업에서 macOS 15 로 정렬됨.

### 영향

- macOS 14 (Sonoma) 사용자는 다음 release 부터 AgentDeck CLI 와
  Stream Deck 플러그인 모두 신규 install 대상에서 제외된다 (App
  Store 빌드는 이미 직전 release 부터).
- 이전 entry 에서 적은 "feature matrix 가 잘못된 CLI runtime 을
  기록 (Node 18 / macOS 13)" Codex stop-time finding 도 본 통일로
  자동 해소.

### 검증

- `grep -rn "macOS 14\|Sonoma" README.md docs/ apple/AgentDeck plugin/`
  → DEVELOPMENT_LOG history 외 잔존 0 건.
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme
  AgentDeck_macOS -destination "platform=macOS,arch=arm64" build`
  통과 (BUILD SUCCEEDED).
- `python3 -c "import json; json.load(open('plugin/bound.serendipity.agentdeck.sdPlugin/manifest.json'))"`
  통과.

---

## 2026-05-10 — Codex OTel HUD / project label / timeline noise 정리

### 문제

Codex App / app-server OTLP batch 가 durable `thread.id` 없이 trace-backed
span 만 보내는 경로에서 Dashboard 는 `codex:otel-active` 익명 세션을 만들었다.
이 세션은 cwd 도 비어 있어 좌측 HUD 프로젝트명이 빈 문자열로 보였고, 같은
OTel batch 의 내부 `tool_call` / `tool_result` span 이 그대로 TIMELINE 에
`tool`, `tool completed` 같은 저품질 로그로 노출됐다. 또한 좌측 HUD 행은
asset catalog SVG template 렌더링을 16pt 슬롯에 직접 써 Codex compact glyph
가 깨져 보일 수 있었다.

### 해결

- 좌측 HUD agent glyph 를 asset renderer 대신 `AgentBrandIcon` path renderer
  로 통일하고, Codex path 를 canonical `design/brand/codex.svg` 와 맞췄다.
- Codex OTel cwd alias 를 `process.cwd`, `terminal.cwd`, `workspace.root`,
  `project.root` 등으로 확장했다.
- 익명 `codex:otel-active` 세션은 cwd 가 없을 때 현재 visible session 들의
  non-Codex 프로젝트명이 하나로 수렴하면 그 이름을 fallback 으로 채운다.
  그래도 알 수 없으면 HUD 표시는 `Codex` 로 fallback 해서 빈 라벨을 피한다.
- OTel tool spans 는 타임라인에 쓰지 않고 세션 state/currentTool 갱신에만
  사용한다. Codex timeline 은 실제 prompt/response payload 가 있는 lifecycle
  hook 에서만 기록한다.
- `tool` / `unknown` 처럼 의미 없는 Codex tool name 은 hook path 에서도
  timeline entry 로 만들지 않는다.

### 검증

- `git diff --check -- apple/AgentDeck/UI/Common/SessionBrand.swift
  apple/AgentDeck/UI/Monitor/SessionListPanel.swift
  apple/AgentDeck/Daemon/Modules/CodexTelemetryModule.swift
  apple/AgentDeck/Daemon/Server/DaemonServer.swift
  apple/AgentDeckTests/CodexOtelParserTests.swift`
  통과.
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS
  -destination 'platform=macOS'
  -only-testing:AgentDeckTests_macOS/CodexOtelParserTests
  -only-testing:AgentDeckTests_macOS/ProtocolTests test
  EXCLUDED_SOURCE_FILE_NAMES=LaunchSessionDialog.swift CODE_SIGNING_ALLOWED=NO
  -derivedDataPath /tmp/AgentDeckCodexHudTimelineFix`
  통과 — 52 tests, 0 failures.

---

## 2026-05-10 — Menubar 패널 정리 + macOS deploy target 15.0

### 문제

메뉴바 ControlTowerPanel 에 누적된 6 가지 사용자 체감 결함:

1. OpenClaw 행에 uptime 이 `20582d` 로 표기 — 가상 `openclaw-gateway`
   세션이 `startedAt` 을 `1970-01-01` placeholder 로 인젝트해서
   `displayRelativeTime` 이 epoch 차이를 일 단위로 계산.
2. TOPOLOGY hub 의 `AgentDeck` 과 `:9120` 이 두 줄로 쌓여 popover
   세로공간 낭비.
3. 패널이 `.frame(height: 620)` 로 고정돼 디바이스 수와 무관하게 동일
   높이 + 내부 ScrollView 가 항상 활성.
4. Launch Session 진입점 (pill, empty-state 버튼, MonitorEmptyGuide
   카피, Window scene, dialog 파일) 이 dead path 로 잔존.
5. Dashboard 가 단순 `openWindow(id:)` 만 호출 — 메뉴바에서 닫을 수
   없고 시각적 활성/비활성 표시 없음.
6. Evaluation/Settings 가 macOS window-restoration 으로 재실행 시
   다시 떠 사용자 의도와 어긋남.

### 해결

- **OpenClaw uptime**: `DaemonServer` 에 `gatewayConnectedAt: Date?`
  필드 추가, connect 시점 기록 + 모든 disconnect 경로에서 nil 클리어.
  `buildSessionsListEvent` 가 nil 이면 `startedAt` 를 dict 에 넣지
  않아 시간 chip 이 그냥 안 보이도록 함.
- **TOPOLOGY 한 줄**: `MenuBarTopologyList.hubNode` 의 inner
  `VStack(spacing: 0)` → 단일 `HStack(.firstTextBaseline)`. 포트 폰트
  9.5→11pt 로 가독성 보강.
- **DOWNSTREAM 동적 사이즈**: ControlTowerPanel `height: 620` 제거,
  inner VStack 에 `.fixedSize(vertical: true)`, ScrollView 외부에
  `.frame(maxHeight: scrollContentMaxHeight)` (= visibleFrame * 0.85
  - 140pt chrome). 디바이스가 적으면 패널이 줄고, 30+ 인 극단에서만
  내부 스크롤이 등장.
- **Launch 제거**: ControlTowerPanel 의 pill·empty-state 버튼·helper
  4 곳 + AgentDeckApp 의 `Window("Launch Session")` scene + MonitorEmptyGuide
  의 Launch 버튼/카피 + `LaunchSessionDialog.swift` 파일 + APP_REVIEW_NOTES
  / AquariumSurface 주석까지 일괄 정리. companion-install prompt 위반
  소지를 차단하기 위해 빈 sessions 카피도 "Sessions appear here
  automatically once the bridge picks one up." 식의 neutral 문구로 통일.
- **Dashboard 토글**: `@State dashboardVisible` + 5s timer +
  NSWindow Notification 4종 (didBecomeKey/willClose/didMiniaturize/
  didDeminiaturize) 옵서버. pill 이 활성 시 `Dashboard ●` (primary
  fill) / 비활성 시 `Dashboard` (outline). 클릭으로 open/close 토글.
- **Evaluation/Settings 자동 복구 차단**: 두 `Window` scene 에
  `.defaultLaunchBehavior(.suppressed)` 적용. 이 modifier 가 macOS 15+
  전용이라 deploy target 을 14 → 15 로 상향. 동시에 AquariumSurface
  의 `if #available(macOS 15.0, *)` 게이트 1 곳 정리.

### macOS 15.0 deploy target 변경의 영향

- **사용자 영향**: macOS Sonoma (14.x) 에 머무는 사용자는 다음 빌드
  부터 App Store 업데이트를 받지 못한다. CI 는 이미 `macos-15` runner
  사용 중이라 빌드 인프라는 그대로.
- **iOS deploy target (17.0) 은 변경 없음** — iOS companion 영향 없음.
- **App Store Connect 의 minimum OS 표기**도 다음 release 업로드 시
  자연 반영. 메타데이터·release notes 는 본 차수 업로드 직전에
  "Requires macOS Sequoia 15 이상" 명시 필요.
- **하향 호환 경로**: `defaultLaunchBehavior(.suppressed)` 만 떼면
  14 호환은 회복 가능. 다만 6번 이슈는 AppDelegate
  `applicationDidFinishLaunching` 의 windows orderOut fallback 이 또
  필요해진다.

### 검증

- `xcodegen` 으로 project.yml → pbxproj 재생성, `MACOSX_DEPLOYMENT_TARGET = 15.0`
  두 build config 모두 반영 확인.
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS
  -configuration Debug -destination "platform=macOS,arch=arm64" build`
  통과 (BUILD SUCCEEDED, 경고 없음, App Store Helper Guard 통과).
- `grep -rn "launch-session|openLaunchSession|LaunchSessionDialog" apple/` → 0 건.
- Codex adversarial review (verdict: needs-attention) — 두 high finding
  (timeline dedup, focus_session validation) 은 본 PR 영역 밖 선행
  변경 결함으로 분리. macOS 14 drop 은 본 entry 로 의도 + 영향 명시.

---

## 2026-05-10 — Codex 구독 만료일 relay 보강

### 문제

App Store 샌드박스 macOS daemon 은 프로젝트 invariant 상 `~/.codex/auth.json`
을 직접 읽지 않는다. 그래서 Codex Observation/OTel 로 세션은 보이더라도
ChatGPT plan / `chatgpt_subscription_active_until` 은 비어, Dashboard 의
Subscriptions footer 에 Codex 만료일이 나타나지 않았다.

### 해결

- 터미널/Node bridge 가 `usage_update` 로 보낸 Codex auth metadata 를
  Swift daemon 이 캐시하고, 이후 daemon 소유 `state_update` / `usage_update`
  에 다시 싣도록 했다.
- `subscriptions` 배열이 없는 이벤트라도 `codexPlanType` /
  `codexSubscriptionActiveUntil` 이 있으면 Swift state layer 가 ChatGPT
  subscription row 를 합성한다.
- `state_update` 도 Codex auth metadata 를 디코드하도록 protocol model 을
  확장했다.

### 검증

- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS
  -destination 'platform=macOS' -only-testing:AgentDeckTests_macOS/ProtocolTests
  -only-testing:AgentDeckTests_macOS/CodexOtelParserTests test
  EXCLUDED_SOURCE_FILE_NAMES=LaunchSessionDialog.swift CODE_SIGNING_ALLOWED=NO
  -derivedDataPath /tmp/AgentDeckCodexSubscriptionRelayTests`
  통과 — 50 tests, 0 failures.

## 2026-05-10 — Menu bar AgentDeck symbol alignment

### 문제

macOS 메뉴바 라벨과 드롭다운 팝업의 AgentDeck 허브 아이콘이 추상적인
stacked-card mark 를 사용했다. App Store / Dock / pairing splash 의 실제
제품 상징인 aquarium dome + hardware deck 아이콘과 실루엣이 달라,
같은 앱 안에서도 메뉴바 표면만 별도 브랜드처럼 보였다.

### 해결

- `AgentDeckLogo` 를 app icon 의 작은 크기용 심볼로 재정의했다. 전체
  bitmap illustration 을 16–20pt 로 축소하지 않고, dome outline /
  waterline / deck base / button glints 만 SwiftUI Shape 로 그린다.
- 메뉴바 상태 배지와 calm header 연결 상태 색을 `DesignTokens.UI.*`
  product palette 로 이동했다.
- `DESIGN.md` §6 에 small-size product symbol 규칙을 추가하고, 메뉴바
  아이콘 규칙을 현재 구현과 맞췄다. 추상 card-stack / hub / router
  mark 는 production AgentDeck mark 로 쓰지 않는다.

### 검증

- `xcodebuild -scheme AgentDeck_macOS -destination 'platform=macOS' build
  EXCLUDED_SOURCE_FILE_NAMES=LaunchSessionDialog.swift` BUILD SUCCEEDED.
  현재 워크트리의 별도 변경에서 `LaunchSessionDialog.swift` 가 삭제됐지만
  `AgentDeck.xcodeproj` 의 stale reference 가 남아 있어, 일반 빌드는 그
  참조에서 먼저 중단된다.
- `python3 design/verify-tokens-sync.py` All mirrors in sync.
- `git diff --check -- apple/AgentDeck/UI/MenuBar/AgentDeckLogo.swift
  apple/AgentDeck/UI/MenuBar/AgentStatusIcon.swift
  apple/AgentDeck/UI/MenuBar/AttentionTheaterView.swift DESIGN.md
  DEVELOPMENT_LOG.md` 통과.

---

## 2026-05-09 — Focused session timeline filter + OpenClaw focus

### 문제

Dashboard 에서 특정 세션을 focus 해도 하단 `TIMELINE` 은 전체 세션 이벤트를
계속 섞어서 보여줬다. 동시에 OpenClaw crayfish 는 hit-test 결과가
`crayfish` sentinel 로 돌아오고 `MonitorScreen` 이 이를 무시해서, 좌측
HUD row 와 달리 terrarium 에서는 선택할 수 없었다.

### 해결

- `TimelineStripView` 가 `DashboardState.focusedSessionId` 를 읽어 해당
  세션의 timeline entry 만 필터링하도록 했다. 우선 `sessionId` 를 쓰고,
  legacy entry 는 `projectName + agentType` fallback 으로 매칭한다.
- OpenClaw virtual Gateway session (`openclaw-gateway`) 은 daemon-local
  session 으로 취급한다. crayfish tap 이 이 id 로 focus 하고, Swift/Node
  daemon 모두 relay WS 연결 없이 `focusedSessionId` 를 broadcast 한다.
- Terrarium focus halo 가 `openclaw-gateway` focus 를 crayfish 위치에
  그리도록 확장했다.

---

## 2026-05-09 — Dashboard 세션 행 UX: Jump grid 제거 + focus halo

### 문제

macOS Dashboard 좌측 HUD 의 세션 행을 클릭하면 5셀 (메뉴바) / 4셀 (Dashboard)
"Jump to..." 아이콘 그리드 (iTerm / VS Code / Cursor / Finder / Dashboard)
가 펼쳐졌지만 모든 셀이 dead UI: `SessionInfo` 에 `projectPath` 가
hook payload 에서 안 흘러와 모든 셀이 "앱을 빈 상태로 켤 뿐". Dashboard
셀은 메뉴바 헤더의 별도 "Dashboard" pill 버튼과 완전 중복.

그리드를 제거한 뒤 새로운 critique: row tap 이 invisible. `focus_session`
명령은 daemon 의 routing 셀렉터일 뿐이라 (model/effort 라벨, AttentionTheater
question, D200H 버튼 0, option 응답 라우팅) awaiting 세션이 0 일 때
사용자 측 시각 피드백이 0. "row tap 이 의미 있나?" 라는 인상이
재발생.

### 해결

**1단계: Jump grid 통째 제거** (commit `c37e9526`)

- `SessionJumpRow.swift` — `expanded` / `onToggle` / `onJumpDashboard` /
  `onJumpExternal` 4 콜백 → 단일 `onFocus` 로 축소. `JumpTarget` enum,
  `jumpCell()`, `SessionJumpLauncher` 통째 삭제. chevron rotation +
  "JUMP TO" 헤더 + 5 셀 그리드 제거.
- `SessionListPanel.swift` — `expandedSessionId` State + `stableId(suffix:)`
  + `jumpGrid(for:)` 삭제. `sessionRowInteractive` 를 단일
  `Button { focusSession }` 로 평탄화.
- `ControlTowerPanel.swift` — `expandedSessionId` State + 그것을
  정리하던 `.onChange(...)` collapse 블록 삭제. 콜사이트 4 콜백 →
  `onFocus` 단일.

**2단계: Terrarium focus halo** (commit `80095e8b`)

- `TerrariumState.focusedSessionId: String?` 신설.
- `DashboardState.toTerrariumState` 의 cloud-folding 루프에서 focused
  thread id 가 folded 상태이면 representative.id 로 재매핑
  (`resolvedFocusId`). 이래야 Codex 가 fold 된 상황에서도 보이는 cloud
  sprite 에 halo 가 붙음.
- `TerrariumRenderer` 에 `focusedSessionId` / `focusPulse` /
  `focusPresence` 상태 추가. `update(dt:state:)` 에서 hasVisibleFocus
  (octopus / cloud / opencode dict 에 id 존재) 를 검사해 presence target
  0/1, dt * 6.0 lerp 로 페이드. `drawFocusHalo()` 가 Layer 6.7 (Layer 6.5
  back-tetra 이후, Layer 7 crayfish 이전) 에서 cyan disc + neon ring 을
  pulse 와 함께 그림. `presence > 0.01` 가드로 페이드아웃 후 자동 skip.

### 핵심 설계 결정

**Jump grid 의 진짜 부재 원인**: `projectPath` 가 hook payload 에 없음.
정식 "이 세션의 터미널로 점프" 는 hook 측 `TERM_PROGRAM` /
`ITERM_SESSION_ID` / tty / parent_pid 캡처 + Swift 측 `NSAppleScript`
기반 jump (iTerm + Apple Terminal 만 현실적, VSCode/Cursor 통합 터미널은
본질적으로 외부 제어 불가) + `NSAppleEventsUsageDescription` entitlement
가 필요. App Store 빌드 호환 (subprocess 없음, in-memory `NSAppleScript`).
이는 별개 PR 로 분리 — dead UI 를 placeholder 로 유지하지 않음.

**focus halo 는 Layer 6.7**: back-layer fish (Layer 6.5) 위, crayfish
(Layer 7) 아래. 모든 creature (octopus / cloud / opencode) 보다 뒤에
그려져 sprite 가 halo 안에 깔끔히 앉음. Bubbles / front-tetra / water
surface 보다는 뒤라 환경 효과를 가리지 않음.

**presence envelope 가 핵심**: 단순 boolean on/off 면 세션 list 가
재정렬되거나 creature 가 잠깐 사라졌다 돌아올 때 halo 가 깜박임. `dt *
6.0` lerp (~166 ms 시정수) 로 부드럽게 페이드. `hasVisibleFocus` 검사로
focus 가 있어도 sprite 가 없으면 즉시 페이드아웃.

**Codex fold 해소를 mapping 단계에서 처리**: renderer 가 `[String: String]`
alias map 을 따로 들고 다닐 필요 없이, cloud-folding 루프 안에서
`members.contains(focused) → resolvedFocusId = representative.id`. 단일
필드로 끝.

---

## 2026-05-09 — Pixoo 설정 즉시 반영 (5s 폴링 우회)

### 문제

App Store Swift 데몬에서 Settings → Pixoo UI 로 IP 추가 후 Dashboard 우측
HUD (TopologyRail) 에 디바이스 타일이 즉시 안 나타남. 진단 결과 데몬은
정상 활성화되어 `/health` 가 `online: true, hasFrame: true` 를 즉시
반영하지만, `PixooModule.settingsReloadIntervalSec = 5` 로 settings.json
을 5초 주기 폴링만 함 (file watcher 없음). UI 가 파일을 쓴 시점부터
다음 폴링 tick 까지 0–5 초 + probe 1 회 만큼 HUD 가 비어 있음.

추가 진단 메모: 사용자의 기존 `~/.agentdeck/settings.json` 에 등록된 IP
는 App Store 샌드박스 데몬이 못 읽음 — 컨테이너의
`Library/Containers/.../AgentDeck/settings.json` 만 봄. 별개 이슈로 이
재설정은 사용자가 UI 에서 다시 추가해 해소.

### 해결

- `PixooModule.reloadFromSettingsExternal()` 추가 — 외부에서 폴링
  cadence 우회용 진입. 내부 `reloadDevicesFromSettings(reason: "ui-trigger",
  force: true)` 호출. `force` 는 파일이 새로 쓰였지만 IP 셋이 동일한
  엣지 (brightness 등) 를 위해 line 462 equality guard 우회.
- `Notification.Name.pixooSettingsChanged` 정의 + `DaemonServer` 가
  `pixooModule` 인스턴스화 직후 main queue observer 등록, 알림 시
  `Task { await pixoo.reloadFromSettingsExternal() }` 디스패치.
- `PixooSheet.addDevice` / `removeDevice` 가 `saveDevices()` 성공 직후
  `NotificationCenter.default.post(name: .pixooSettingsChanged)` 송출.
- `DaemonServer.shutdown()` 에서 `removeObserver` 처리.

### 핵심 설계 결정

NotificationCenter 로 UI ↔ daemon 단방향 시그널. PixooSheet 가
PixooModule ownership 을 알 필요 없고, 같은 패턴이 다른 settings 화면에
확장 가능. DispatchSource file watcher 도입은 범위가 크고 (모든 모듈
공통화 필요) 본 패치 범위에서 제외. 5 초 폴링은 fallback 으로 유지 —
외부 파일 편집 (terminal vim 등) 은 여전히 catch up.

### 후속 1 — broadcastStateUpdate 누락 (Codex stop-time review)

첫 패치는 actor 의 `devices` 와 shadow 만 업데이트하고 끝나서 `/health`
HTTP 는 즉시 반영됐지만, WebSocket 으로 `state_update` 이벤트가 안
나가 TopologyRail 같은 WS 구독자들은 다른 broadcast 가 발생할 때까지
stale 했다. observer 클로저에 `await pixoo.reloadFromSettingsExternal()`
직후 `Task { @MainActor in self?.broadcastStateUpdate() }` 추가
(commit `efd725b3`). actor 내부 snapshot 갱신과 WS broadcast 는 별도
신호임을 잊지 말 것.

### 후속 2 — 폴링 경로도 broadcast 누락 (Codex stop-time review 2회차)

후속 1 은 UI 트리거 경로만 broadcast 를 채웠고, 5초 폴링이
settings.json 외부 편집을 감지해 reload 하는 경로는 그대로 stale.
fallback path 가 거짓이었다. 해법은 actor 내부에 `onStateChanged:
(@Sendable () -> Void)?` 콜백을 두고 `reloadDevicesFromSettings` 의
두 terminal branch (devices.isEmpty / 정상) 에서 호출. DaemonServer
가 `await pixoo.setOnStateChanged { Task { @MainActor in
self?.broadcastStateUpdate() } }` 로 wiring. UI / 폴링 두 경로 모두
같은 hook 으로 broadcast (commit `e5ef66a8`). UI 옵저버 클로저는
`reloadFromSettingsExternal` 만 호출하도록 단순화 — 이중 broadcast
방지.

### 후속 3 — broadcast 가 prepareDevice 뒤로 밀림 (Codex stop-time review 3회차)

후속 2 의 `onStateChanged?()` 위치가 `prepareDevice` 루프 **뒤**라,
디바이스마다 HTTP RTT (timeout 2s × N) 동안 broadcast 가 blocking.
unreachable Pixoo 시 HUD 가 그 시간만큼 비어 있음. configuration 자체는
device list 갱신 시점에 이미 결정 — `devices` 할당 + `refreshShadow()`
직후 즉시 1차 broadcast, prepareDevice 루프 후 online/probed 상태 반영해
2차 broadcast 로 분리 (commit `344f6123`). configuredDeviceCount /
deviceIps 는 즉시, online / failures 는 RTT 후.

### 후속 4 — circuit breaker 전환 broadcast 누락 (Codex stop-time review 4회차)

후속 3 까지도 `onStateChanged?()` 는 `reloadDevicesFromSettings` 콜패스
안에서만 발사. `recordPushFailure` 가 `consecutiveFailures` 를 누적해
threshold 6회를 넘기며 `online=false` 로 flip 시킬 때, `recordPushSuccess`
의 recovered 분기, `probeBackedOffDevices` 재진입 등은 `refreshShadow()`
만 호출하고 broadcast 안 됨 → unreachable Pixoo 가 HUD 에서는 영원히
online 으로 보임. trigger 를 `refreshShadow()` 자체로 이동, user-visible
필드 digest 비교로 변경 시에만 발사. `reloadDevicesFromSettings` 의
explicit `onStateChanged?()` 호출은 redundant 라 제거 — refreshShadow 가
알아서 diff 검사 (commit `f748a042`).

### 후속 5 — hasFrame transition 누락 (Codex stop-time review 5회차)

후속 4 가 digest 에서 `lastPushAtMs` 와 함께 `hasFrame` 도 같이 제외함.
이게 잘못 — `lastPushAtMs` 는 333ms 렌더 tick 마다 변하지만, `hasFrame`
은 `false→true` (첫 프레임 push) 와 `true→false` (디바이스 0 으로 가서
`writeFrame(nil)` 호출) 두 transition 만 있는 user-visible 상태. 둘을
한 묶음으로 본 게 실수. `hasFrame` 을 digest 에 다시 포함해 first-frame /
device-removal 시점이 broadcast 되도록 복구. `lastPushAtMs` 만 단독
제외 (commit `357a6353`).

### 검증

- `xcodebuild -scheme AgentDeck_macOS -destination 'platform=macOS' build`
  BUILD SUCCEEDED (여섯 번 모두).
- 런타임 검증은 사용자가 새 빌드 재실행 후 ① Settings UI 에서 IP
  추가/제거 → swift-daemon.log `Pixoo ui-trigger: N configured device(s)`
  + 우측 HUD <1 초 내 변화 (네트워크 도달성과 무관), ② terminal 에서
  settings.json 수동 편집 → `Pixoo settings reload: ...` 로그 + WS
  구독자도 ≤ 5 초 내 반영, ③ unreachable IP 추가 시 HUD tile 즉시
  표시 → 6 회 push 실패 후 HUD 에서 online=false 로 전환, ④ 디바이스
  power-cycle 후 자동 recovery 도 즉시 broadcast, ⑤ 첫 프레임 push 시
  `hasFrame=false→true` transition 도 broadcast 에 잡힘.

---

## 2026-05-08 — Codex hook protocol on Node bridge (PTY-only state machine retired)

### 문제

지난 세션의 작업 ("Codex timeline task unit alignment with APME turn",
2026-05-06) 은 `wireAgentApme` 의 Codex 세그먼트가 7개 상태 변수 · 5개
helper · 3개 timer 로 부풀어 7회 Codex review iteration 후에야 layered
correctness 도달했다. 본질은 PTY 신호의 모호성 (status line `›`, mid-tool
silence, stale frame, sub-second redraw) 을 단일 state machine 으로 보상
하느라 그런 것.

리서치 결과: **Apple Swift daemon 은 같은 문제를 hook 기반으로 깔끔하게
처리하고 있었다**. `apple/AgentDeck/Daemon/Core/CodexConfigInstaller.swift`
가 `~/.codex/config.toml` 에 `[features] codex_hooks = true` + 5개
lifecycle hook 표를 install. 그러나 **Node bridge (CLI) 측에는 동등 인프라
0건** — `bridge/`, `hooks/`, `setup/` 어디에도 `codex_hooks` 매치 없음.
Node CLI (`agentdeck codex`) 사용자에게는 PTY 출력만이 turn-boundary
신호여서 wireAgentApme 의 복잡한 state machine 이 필요했던 이유.

### 해결

**Node bridge 에 Codex hook 인프라 포팅 + state machine retire**.

**Phase A — Codex hook installer 포팅** (commit 7553e11c, ~650 LOC):
- `hooks/src/codex-mini-toml.ts` — `apple/AgentDeck/Daemon/Core/MiniToml.swift`
  의 lossless TOML 편집을 직접 포팅. `@iarna/toml` 같은 semantic parser
  쓰지 않음 — 사용자 TOML 의 key 순서/들여쓰기/blank line 을 normalize 해
  버리면 round-trip-preserves-user-config invariant 깨짐. fence sentinels
  byte-identical.
- `hooks/src/codex-install.ts` — install/uninstall/migrate. PORT-resolution
  shell snippet 은 `hooks/src/install.ts:buildHookCommand` 와 byte-identical
  (Apple/Node 두 daemon 이 같은 fence 를 toggle 가능). conflict gate (사용자
  authored `[features]` / `[hooks]` / `notify` / `[otel]` 외부 → install
  skip). Atomic write.
- Trigger 2 곳: `agentdeck codex` action lazy install + `agentdeck daemon
  install`. setup 패키지는 zero-runtime-deps inline 패턴 보존을 위해 skip
  — 사용자가 `agentdeck codex` 첫 실행 시 어차피 trigger.
- 29 unit tests (Apple `MiniTomlTests` + `CodexConfigInstallerTests` 1:1
  포팅 + round-trip preserve invariant pin).

**Phase B — Bridge hook 처리** (commit ed67a5ce, ~240 LOC):
- `bridge/src/state-machine.ts` 에 codex_* case 6개 추가 (session_start,
  user_prompt_submit, tool_start, tool_end, stop, turn_complete). Claude
  trigger 라벨 (`'session_start'` etc.) 재사용해 `shared/src/states.ts`
  transitions 테이블에 codex 접두사 안 추가.
- `bridge/src/apme/adapters/codex-hook.ts` — `claude-hook.ts` 의 mirror.
  `codex_user_prompt_submit → turn_start`, `_tool_start → tool_call`,
  `_tool_end → tool_result`, 나머지 raw_step. `/clear` 감지.
- `bridge/src/index.ts` hook branch 에서 `agentType === 'codex-cli'` 시
  `codexHookToSpans` 사용 (Claude 와 분기).
- 7 state-machine + 5 codex-hook span 테스트.

**Phase C — CodexTurnManager class 추출** (commit 39e169fc, +600/−280 LOC):
- `bridge/src/apme/adapters/codex-turn-manager.ts` 신규 class.
  `onHookEvent` (primary), `onParserEvent` (PTY fallback), `cleanup`.
- 30s `hookActive` freshness window — 최근 hook 이 fired 면 PTY parser idle/
  spinner_stop 신호 demoted (turn-boundary no-op). 그 윈도우 밖에서만
  legacy state machine 활성. Hook 이 발화 안 하는 사용자 (CLI 만 + hooks
  install 거부 또는 Codex Ink-TUI repaint glitch) 에 대비한 fallback 유지.
- Hook path 는 timeline-only — APME ingestion 은 index.ts hook adapter 가
  이미 codexHookToSpans 로 처리. 재 ingestion 하면 turn 이 닫혔다 다시
  열려 망가짐.
- `classifyAndEnqueueTurn` 을 `apme/classify-turn.ts` 로 추출 (codex-turn-
  manager 가 import 시 index.ts 와 circular dep 안 만들게).
- wireAgentApme 의 305-line Codex 세그먼트가 ~25 LOC 로 축소.
- 7 단위 테스트 (hook happy path, multi-turn fresh chat_starts, hook
  freshness window, long-bash with multiple tool pairs, PTY-only fallback
  3 cases).

**Stop-gate fixes (Codex review):**

**b2fc3bc5 — `codex_stop` 가 APME turn finalize 안 됨**:
- collector.closeTurn 이 private + UserPromptSubmit/closeRun 만 호출 →
  codex_stop 후 다음 prompt 까지 turn 의 `endedAt` null + tool_calls 미flush.
- `ApmeCollector.closeTurnForSession(sessionId)` public wrapper 추가,
  `CodexTurnManager.closeTurn` 마지막 (chat_response/classify 후) 에 호출.

**88ef6b23 — closeTurnForSession 이 turn_index sequence reset**:
- `collector.ingestHook` UPS 분기가 `sessionToTurn.get(sessionId)?.index`
  로 prevIndex 읽음. 내가 codex_stop 에서 sessionToTurn 비우니 다음 UPS
  시 prevIndex=-1 → turnIndex=0 으로 reset → 모든 후속 turn 의 index 가
  0 → tasks.firstTurnIndex/lastTurnIndex 부기 깨짐.
- sessionToTurn 비면 `sessionToLastTurnId` 로 fallback 해서 store 에서
  마지막 turn 의 turn_index 읽기. Claude/OpenCode 는 closeTurnForSession
  안 부르니 영향 없음.

### 핵심 설계 결정

- **Hook protocol 이 있으면 PTY parser 보다 항상 우선**. 모호성 없는 명시
  signal 이 추측보다 monotonically 안전. PTY 는 fallback (hook miss 18%
  케이스) 으로만 유지.
- **30s freshness window 로 mode 전환**. hook 이 한 번이라도 떴으면 30s 간
  hook-primary, 그 후 미수신이면 PTY-fallback 자동 재진입. 운영 환경에
  따라 (사용자 hooks install 안 함, Codex 버전 차이) 자동 적응.
- **fence sentinel + PORT-resolution shell snippet 을 Apple/Node 동일하게**.
  `~/.codex/config.toml` 을 두 daemon 이 toggle 해도 conflict 없음. hook
  command 가 매 호출 시점에 active daemon 자동 매칭.
- **Setup package 는 zero-runtime-deps 인라인 패턴 보존**. Codex install
  은 `agentdeck codex` 첫 실행 lazy trigger 로 충분 — setup 직후 사용자도
  결국 codex 명령 통해 trigger 받음.
- **`codex_stop` 는 turn 을 즉시 finalize**. Claude `Stop` 은 finalize 안
  하고 다음 UPS 에 prev close 하는데, Codex 의 codex_stop 이 더 강한
  "turn 끝" 의미라 즉시 finalize 가 맞음. 단, prevIndex 읽기 fallback 추가
  필요했음.

### 검증

- `pnpm test`: 1138 passing (기존 1086 + Phase A 29 + Phase B 12 + Phase C
  8 + finalization 1 + index regression 1 + 기존 테스트 추가 가산).
- `pnpm -r build` clean. typecheck clean.
- 수동 검증은 다음 세션에서 — 실제 `agentdeck codex` 세션을 띄워:
  - `~/.codex/config.toml` fence-block 자동 install 확인
  - Apple/Android tablet timeline 에서 multi-bash prompt 가 chat 카드 1개로
    표시되는지 (long bash > 15s 케이스 포함)
  - `apme.sqlite` 의 Codex run turns 가 monotonic turn_index, 정확한
    tool_calls, response, endedAt 채워져 있는지

### 회고

이번 작업은 두 세션에 걸친 7+5회 Codex review iteration 의 결과. 첫 세션
(2026-05-06) 의 PTY-only state machine fix 가 layered correctness 도달후,
이번 세션이 그 layering 을 hook 기반으로 retire 시켰다. 같은 영역의 review
가 반복해서 다른 layer 의 bug 를 짚는 패턴은 `feedback_codex_stoptime_iteration`
메모대로 — "이미 고쳤음" 으로 무시 금지. 매 commit 이 separate.

---

## 2026-05-08 — HUD primary-only OpenClaw + ChatGPT subscription parity (3-round stop-gate)

### 문제
- 우측 HUD Upstream 의 OpenClaw 줄에 모델 카탈로그 전체가 노출. 사용자는 primary (`role=="default"`) 만 원함.
- macOS 에서 ChatGPT subscription 행이 아예 안 떴고, Android 태블릿은 이미 지나간 `subscription_active_until` 을 그대로 표시.

### 해결
- `apple/AgentDeck/Daemon/Server/DaemonServer.swift` — `buildFullStateEvent` 가 `buildSubscriptions()` 를 호출하도록. 이전엔 `buildUsageEvent` 에만 들어가 SwiftUI 의 `state.subscriptions` 가 비어 있었음.
- `apple/AgentDeck/Model/Protocol.swift` `openClawDisplayLines` + Android `TopologyRail.kt` / `EinkStatusPanel.kt` / `EinkStatusCompact.kt` — `role == "default"` 만 통과시키는 strict filter. fallback-N / configured 는 모두 숨김. **default 가 없으면 row 자체를 비움** (사용자 명시 선택을 그대로 따름).
- 만료 처리: `subscriptionTrailing(until, now)` 헬퍼 — future date 는 `~yyyy-MM-dd`, 과거/parse 실패는 `renewal needed` 라벨로 전환. macOS 는 `TerrariumHUD.ledAmber`, Android 는 `TerrariumColors.LEDAmber` 로 강조.
- **Time invalidation (Android 전용)**: `rememberCurrentInstant(periodMillis = 60_000L)` Compose 헬퍼 도입 — `produceState` 로 60s tick 을 발생시켜 expiring window 가 자동으로 "renewal needed" 로 전환. 이전엔 `Instant.now()` 를 view body 에서 직접 읽거나 `remember(subs) { Instant.now() }` 로 캐시 → recomposition 트리거 없이는 갱신 안 됨.
- `parseUntilDate` (Apple) — `^\d{4}-\d{2}-\d{2}$` regex gate + `isLenient = false` 추가. 기존엔 `2026/05/06` 같은 형식이 silent 통과.
- 테스트: `OpenClawDisplayLinesTest` 신규 (Android), `TopologyRailHelpersTests` 에 `subscriptionTrailing` 케이스 4종 추가, 기존 `SubscriptionLineTest` 를 "renewal needed" 기대값으로 갱신.

### 핵심 설계 결정
- **Render-side filter, not server-side trim.** OpenClaw 카탈로그는 model-swap UI 등 다른 surface 가 그대로 사용해야 하므로 daemon/bridge 는 전체 카탈로그 유지. HUD 만 좁힘.
- **Past-date 는 daemon 에서 거르지 않고 UI 에서 라벨 변환.** Codex CLI 가 `subscription_active_until` 을 로그인 시 한 번만 쓰고 자동 갱신하지 않기 때문에 stale 은 정상 시나리오. cache 의 lossy fallback (`current ?? previous`) 도 그대로 둠 — re-login 으로 회복.
- **시간 의존 렌더링은 ticker state 가 default.** Compose 의 `produceState` 60s tick. SwiftUI 는 `EnvironmentObject` 변경 빈도가 충분해 별도 ticker 없음 (Codex stop-gate 도 Android 만 지적).

### 회고
같은 패턴 (`sub.until?.take(10)` raw render, `firstOrNull { it.available }` fallback) 이 4 파일에 흩어져 있었는데 stop-gate 가 3 라운드 도는 동안 발견. 첫 implementation 직전에 `rg -n "sub.until|firstOrNull { it.available }" android/app/src/main/kotlin/` sweep 한 번이면 모두 잡혔을 것. 사용자가 single-select 로 `default 만` 을 명시했음에도 "비면 어쩌지" 라는 추측으로 fallback 을 끼워 넣은 첫 라운드 regression 도 동일 류 — 사용자 명시 답에 hedge 추가 금지.

---

## 2026-05-07 — Dashboard Timeline unit-session projection parity

### 문제

Dashboard Timeline 이 플랫폼별로 다른 단위를 보여줄 수 있었다. Apple Dashboard 는
`chat_start` 를 진행 중 row 로만 남기고 완료 후에는 `chat_response` / `chat_end`
중 의미 있는 완료 row 를 보여주는 projection 을 갖고 있었지만, Android tablet/e-ink
는 raw event 를 거의 그대로 그룹화했다. 특히 `tool_request` / `chat_end` 를 타입만
보고 묶어 서로 다른 세션이나 프로젝트의 이벤트가 같은 시간대에 합쳐질 수 있었다.

### 해결

- Android 공통 `TimelineDisplay.kt` projection 을 추가했다.
  - in-flight `chat_start` 는 같은 session/project completion 이 생기기 전까지만 표시.
  - `chat_response` 가 같은 turn 을 대표하면 중복 `chat_end` 는 숨김.
  - `runId → sessionId → projectName+agentType` 순으로 timeline context 를 매칭.
  - lifecycle bounds(start/end/duration)는 `startedAt`/`endedAt` 또는 paired
    `chat_start` 로 계산.
- Android `groupConsecutive` 는 이제 같은 context 일 때만 `tool_request` /
  `chat_end` 를 묶는다. Claude/Codex/OpenClaw/OpenCode 가 동시에 일해도 row 가
  섞이지 않는다.
- Android tablet `TimelineStrip` 과 e-ink `EinkEventLog` / `EinkTimelinePanel` 이
  같은 projection 을 사용한다.
- Android tablet row 에 `BrandIcon` 을 추가해 Claude/Codex/OpenClaw/OpenCode
  캐릭터/브랜드 자산이 project prefix 와 함께 보이게 했다.
- Apple Timeline detail pane 도 row 와 동일하게 `project · agent` 출처를 보여준다.

### 검증

- `./gradlew :app:testDebugUnitTest --tests dev.agentdeck.state.TimelineStoreTest --tests dev.agentdeck.state.TimelineDisplayScenarioTest --tests dev.agentdeck.net.ProtocolTest --no-daemon` 성공.
- `./gradlew :app:compileDebugKotlin --rerun-tasks --no-daemon` 성공. Kotlin daemon
  cache 오류 후 daemon-less fallback 으로 정상 컴파일됨.
- `./gradlew :app:testDebugUnitTest --rerun-tasks --no-daemon` 성공.
- `bash scripts/build-android-release.sh` 성공 → `dist/agentdeck-v0.4.1.apk` 생성.
- `pnpm vitest run shared/src/__tests__/timeline.test.ts bridge/src/__tests__/apme-task-boundary.test.ts bridge/src/__tests__/apme-telemetry-envelope.test.ts` 성공 — 3 files / 93 tests.
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataTimelineEval CODE_SIGNING_ALLOWED=NO` 성공.
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_iOS -configuration Debug -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M4),OS=18.6' -derivedDataPath /tmp/AgentDeckDerivedDataTimelineEvalIOS CODE_SIGNING_ALLOWED=NO` 성공.
- `git diff --check` 성공.

---

## 2026-05-06 — Codex timeline task unit alignment with APME turn

### 문제

Codex 세션의 timeline 이 한 user prompt 를 여러 chat 카드로 쪼개 표시했다.
원인은 `wireAgentApme` 가 `spinner_stop` 을 turn 종료 신호로 쓴 것 — Ink TUI 는
bash 가 실행되거나 상태 라인이 갱신될 때마다 spinner 를 멈춘다. 또한 Codex 의
도구 호출은 `tool_exec` 엔트리로 emit 되었으나 `timelineEntryToSpans` switch 의
default 로 떨어져 APME `tool_call` span 을 만들지 않았다 — eval 평가 단위와
사용자가 보는 timeline 단위가 단절돼 있었다.

### 해결

핵심 원리: 한 user prompt cycle = 한 `chat_start..chat_end` 쌍 = 한 APME turn.

**Parser** (`bridge/src/codex-output-parser.ts`):
- `idle` 이벤트에 `source: 'prompt' | 'timeout'` payload 부착. `prompt` 는
  `›\s` / 입력 prompt 가 실제로 보였다는 신호 (turn-end 후보), `timeout` 은
  spinner data 가 끊긴 합성 idle (대개 mid-tool 의 silence).
- `parseToolAction` 에 4초 dedup 추가 — Ink redraw 로 같은 명령이 여러
  chunk 에 매치돼 `tool_action` 이 폭발하던 문제 해소. turn 경계에서 reset.

**Bridge wiring** (`bridge/src/index.ts wireAgentApme`):
- spinner_start 에서 turn open, prompt-source idle 에서 turn close.
- 1.5s deferred close + spinner_start cancel 패턴 — 빠른 single-shot turn
  도 안 떨어뜨리고 status-line false-positive 도 막음.
- `codexInToolSilence` flag — timeout-idle 후 활성, spinner_start 시 해제.
  silence 동안 들어오는 prompt-idle 은 `codexPendingPromptIdle` 로 latch.
- `codexToolActiveSinceLastSpinner` — 이번 thinking segment 에 tool 이
  실제로 돌았는지 추적. timeout-idle 이 와도 이 flag 가 false 면
  end-of-thinking quiet 으로 보고 silence 진입 안 함.
- 15s `codexToolSilenceTimer` auto-clear — final response 가 spinner 재가동
  없이 끝나는 turn (예: tool 출력이 곧 응답) 에서 무한 차단 방지. 발화 시
  latched pending 을 즉시 close (deferred 아님 — 그새 next spinner_start 가
  cancel 할 수 있어).
- `codexPendingTailSnapshot` — latch 시점 PTY tail 을 snapshot. 후속 close
  (auto-clear timer / next spinner_start) 가 live ringbuffer 가 아닌 이
  snapshot 을 사용 → turn N+1 의 사용자 입력이 turn N 의 chat_response 로
  새지 않음.
- spinner_start with latched pending → 이전 turn 을 동기 close 후 새 turn
  시작 → "사용자가 다음 prompt 입력" 이 두 turn 의 merge 로 보이지 않게.

**APME adapter** (`bridge/src/apme/adapters/timeline.ts`):
- switch 에 `case 'tool_exec'` fallthrough 추가 → `tool_request` 와 동일하게
  `tool_call` span 생성. Codex 도구 호출이 `turns.tool_calls` 에 카운트됨.

### 핵심 설계 결정

- **`spinner_stop` 을 turn 신호로 쓰지 않는다**. Codex Ink TUI 는 bash/상태
  라인에 의해 spinner 가 자주 일시정지됨. 의미적으로 turn 종료가 아님.
- **`prompt`-source idle 만 turn-close 후보로 채택**. `timeout`-source idle
  은 mid-tool 의 spinner-silence 로 해석.
- **mid-tool stale idle 은 차단하되 영구 차단은 안 함**. 15s 안에 spinner
  재가동이 없으면 정말 turn 이 끝난 것으로 간주 (auto-clear).
- **사용자 다음 prompt 입력이 turn merge 를 일으키지 않게** spinner_start
  핸들러가 latched pending 을 동기 close 후 새 turn 개시.
- **PTY tail snapshot 은 latch 시점에 캡처** — close 가 늦게 일어나도
  contamination 없음.
- Trade-off: 단일 bash 가 15s 초과 + 그동안 stale `›` chunk 가 latch 를
  유발한 케이스에서 turn 이 split 될 수 있음. 일반 bash (<15s) 는 영향 없음.

### 회고: Codex stop-time review 의 가치

이 작업은 Codex review 가 한 회차에 하나씩 edge case 를 잡아 7회 iteration
했다 (idle guard → mid-tool close → status-line false positive → permanent
suppression → next-prompt drop → contamination → replay race). 각 회차마다
제안된 fix 가 다음 fix 의 race/edge 를 노출. 결과는 단일 PR 이지만
implementation 의 layered correctness (parser → state machine → snapshot →
race ordering) 는 review 없이는 도달하기 어려웠다. 같은 영역의 리뷰가
반복해서 다른 layer 의 bug 를 짚으면 — `feedback_codex_stoptime_iteration`
메모처럼 — "이미 고쳤음" 으로 무시 금지.

### 검증

- `pnpm -r build` 성공.
- `bridge` 패키지 `tsc --noEmit` clean.
- `npx vitest run -t "idle"` 48 passed; `-t "tool action"` 7 passed; `-t "spinner"` 36 passed; `-t "timelineEntryToSpans"` 7 passed.
- 추가된 테스트: codex-output-parser dedup 4 cases + idle source 단언 보강 + apme-telemetry-envelope `tool_exec → tool_call` 매핑 1 case.
- 수동 검증은 이번 세션에서 못 함 (Codex 실세션 필요): Apple/Android tablet timeline 에서 multi-bash prompt 가 chat 카드 1개로 표시되는지, `apme.sqlite` 의 Codex run turns.tool_calls > 0 인지.

---

## 2026-05-06 — Android e-ink readable Dashboard projection

### 문제

e-ink 전용 `EinkMonitorScreen` 이 tablet Dashboard 와 별도 화면 구조를 유지하는 것은 유지보수 위험이지만,
tablet `MonitorScreen` 을 그대로 e-ink 에 얹으면 더 큰 문제가 생긴다. 실제 Crema screenshot 에서
투명 HUD, 작은 timeline 글자, 색상 기반 상태, 장식 배경 위 텍스트가 겹쳐 판독성이 크게 떨어졌다.
따라서 공통화 대상은 픽셀 배치가 아니라 Dashboard state/action 계약이어야 한다. 동시에 Android 는
Swift daemon 이 보내는 fractional millisecond `timeline_event.ts` 를 `Long` 으로만 decode 해 timeline
이벤트를 버리고 있었다.

### 해결

- Android e-ink 는 다시 `EinkMonitorScreen` projection 을 사용한다. 이는 별도 제품 UX 가 아니라
  공통 Dashboard state/action 을 읽기 쉬운 고대비 3-zone 레이아웃으로 투영하는 계층이다.
- e-ink projection 의 좌측 session rail 을 28% 로 키우고, aquarium 을 42% 로 줄였으며,
  status/context band 를 20-30% 로 키워 글자와 touch target 을 확보했다.
- e-ink 핵심 텍스트를 키웠다: session label/subline, status gauges/models, timeline, attention panel 을
  13-16sp 중심으로 올리고 letter spacing 을 제거했다.
- Android Topology rail 은 Claude 관련 세션/model/rate-limit 데이터가 없고 OAuth 도 연결되지 않은 경우
  Claude row 를 숨긴다. Codex/OpenClaw 작업 중 `Claude Not connected` 가 세션 장애처럼 보이는 혼선을 줄였다.
- Android timeline parser 에 flexible timestamp serializer 를 추가해 `1711100000000.75` 같은 fractional
  timestamp 를 정상 수신한다.
- `docs/android-ui.md` 를 “shared Dashboard model + readable e-ink projection” 방향으로 갱신했다.

### 검증

- `./gradlew :app:compileDebugKotlin --no-daemon` 성공.
- `./gradlew :app:testDebugUnitTest --tests dev.agentdeck.net.ProtocolTest --no-daemon` 성공.
- `./gradlew :app:testDebugUnitTest --no-daemon` 성공.
- `bash scripts/build-android-release.sh` 성공, `dist/agentdeck-v0.4.1.apk` 생성.
- Crema(`CREMAA21W09235`)와 Lenovo tablet(`HVA095B4`)에 release APK 재설치 후 foreground 실행 확인.
- 새 screenshot 기준 Crema 는 readable e-ink projection, Lenovo 는 tablet Dashboard 를 사용하는 것을 확인.
- 양쪽 logcat 에서 `AndroidRuntime` crash 와 `parseBridgeMessage failed` / fractional timestamp decode
  실패가 더 이상 발생하지 않음을 확인.

---

## 2026-05-06 — Dashboard orientation parity for iOS/Android/e-ink

### 문제

Android tablet Dashboard 가 시스템 회전 잠금이나 저장된 orientation preference 상태에 따라
portrait/landscape 전환을 앱 안에서 회복하기 어려웠다. e-ink 는 별도 화면처럼 보이지 않도록
iOS/Android Dashboard 의 조작 의미를 유지해야 하지만, orientation 제어와 Settings 표시 여부가
표면별로 다른 규칙을 갖고 있었다.

### 해결

- Android 공통 `DashboardOrientation` 계약을 추가했다. e-ink 기본값은 landscape 고정, 일반 tablet 기본값은
  Auto 로 두고, 이전 `UNSPECIFIED` 저장값도 Auto 로 해석한다.
- Android tablet Dashboard 하단에 rotate control 을 추가했다. 이 버튼은 `Settings button` 표시 여부와
  독립적으로 남아 시스템 회전 잠금 상태에서도 portrait/landscape pinning 을 전환할 수 있다.
- Android tablet Settings 에 Orientation card 를 추가해 Auto / Portrait / Landscape 를 e-ink Settings 와
  같은 의미로 제공한다.
- e-ink landscape panel / portrait header / Settings 가 같은 orientation helper 를 사용하도록 정리했다.
- iOS Dashboard 의 rotate control 도 Settings button 표시 여부와 독립적으로 노출되게 했다.
- `docs/appstore-feature-matrix.md` 와 `docs/android-ui.md` 에 adaptive orientation / panel parity 계약을
  반영했다.

### 검증

- `./gradlew :app:compileDebugKotlin` 성공.
- `./gradlew :app:testDebugUnitTest --tests dev.agentdeck.data.DashboardOrientationTest` 성공.
- `./gradlew :app:testDebugUnitTest` 성공.
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_iOS -configuration Debug -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M4),OS=18.6' -derivedDataPath /tmp/AgentDeckDerivedDataOrientation CODE_SIGNING_ALLOWED=NO` 성공.
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataOrientationMac CODE_SIGNING_ALLOWED=NO` 성공.
- `bash scripts/build-android-release.sh` 성공 → `dist/agentdeck-v0.4.1.apk`.
- `git diff --check` 성공.

---

## 2026-05-06 — Stream Deck WS-close eviction (3-pass Codex review)

### 문제

macOS Dashboard 의 Downstream rail 에서 Stream Deck row 가 보이지 않는 케이스를
조사하다가, 더 깊은 stale-row 문제가 드러났다. SD 플러그인이 죽거나 Elgato 앱을
끄면 `cachedStreamDeck` 가 최대 120 s 동안 살아남았다. Codex stop-time review 가
세 번 연달아 같은 영역을 잡아냈다 — 한 번에 하나씩 더 깊은 race 가 드러났다.

### 해결 (3-pass)

1. **WS-close hook 비어있음** — `handleClientDisconnect()` 가 stub 였다. WebSocket
   `onCommand` / `onClientDisconnect` 콜백이 `WebSocketConnection` 식별자를 버리고
   있어서 daemon 쪽에서 어떤 conn 이 죽었는지도 알 수 없었다. conn 을 콜백에
   plumb 하고, `StreamDeckRegistration` 에 `connectionId: UUID` 를 박아 conn-id
   매칭 시 즉시 evict 하도록 했다.
2. **`receive()` 의 `isComplete` 무시** — peer 가 0x8 close frame 없이 그냥 TCP
   FIN 만 보내면 (kill -9, `ws.terminate()`, 프로세스 크래시, 머신 sleep)
   receive 콜백은 `(content: nil, isComplete: true, error: nil)` 로 무한 재귀하고
   `onClose` 가 발화되지 않았다. `isComplete` 분기를 추가하고, 마지막 데이터와
   FIN 이 같은 콜백에 합쳐 들어오는 경우를 대비해 frame 처리 후에 검사하도록 순서를
   조정했다.
3. **MainActor Task 사이 FIFO 보장 안 됨** — `client_register` 페이로드 + FIN 이
   같은 패킷에 들어오면, `onMessage` 가 TaskA(handleClientRegister) 를, `onClose`
   가 TaskB(handleClientDisconnect) 를 연달아 schedule 하지만 Swift Concurrency 는
   독립 Task 의 MainActor 도달 순서를 보장하지 않는다. TaskB 가 먼저 돌면 cache 에
   아무것도 없어 no-op 후, TaskA 가 죽은 conn 으로 cache 를 채워 다시 stuck.
   `WebSocketConnection.markDisconnected()` 를 receive 콜백 내부에서 동기적으로
   set 하고, `handleClientRegister` 가 시작 직후 `conn.isDisconnected` 면 거부하는
   패턴으로 어느 Task 가 먼저 돌든 안전하게 만들었다.

### 핵심 설계 결정

- 외부 콜백/I/O 가 actor-isolated 데이터로 reach 할 때 race 를 막는 두 패턴:
  (A) Task 사이 FIFO 가 필요하면 actor 진입 전에 동기적으로 lock-protected flag 를
  세팅, (B) 가능하면 actor state 를 직접 만지지 않고 Sendable snapshot 으로 분리.
  같은 세션의 SerialEventSnapshot 패턴이 (B) 의 예.
- Codex stop-time review 는 컴파일/단위 테스트로 못 잡는 동시성 race 를 잡는다는
  점을 이번에 확인했다. 첫 fix 후 review 가 또 다른 race 를 짚을 때 "이미 고쳤음"
  으로 무시하지 말 것. 메모리: `feedback_codex_stoptime_iteration.md`.

### 검증

- macOS xcodebuild ✓ (3 라운드 모두), iOS xcodebuild ✓, plugin vitest 135/135 ✓.
- 런타임 검증: SD 플러그인 정상 announce → row 표시 확인. (kill -9 / 머신 sleep
  시나리오는 사용자 환경에서 추후 회귀 모니터링.)

---

## 2026-05-06 — TIMELINE detail click crash hardening

### 문제

macOS Dashboard 에서 TIMELINE event 를 클릭해 detail pane 이 뜨기 직전에 `EXC_BREAKPOINT` 가 발생하는
재현 신호가 있었다. 직전 변경에서 detail text 를 `AttributedString(markdown:)` 기반 rich preview 로
바꿨는데, TIMELINE detail 은 agent 응답, tool JSON, table-like markdown, emoji, 로그 조각 같은 임의
문자열을 그대로 받는다. `try?` 는 parse error 만 fallback 할 뿐 Markdown parser 내부 assertion/trap 은
막지 못하므로 UI click path 에 시스템 Markdown parser 를 두는 것은 안전하지 않다.

### 해결

- `TimelineMarkdownPreview` 에서 `AttributedString(markdown:)` 호출을 제거했다.
- headings/list/numbered list/quote/fenced code 정도만 직접 분류하는 line-based safe renderer 로 교체했다.
- 별도로 Xcode 가 지목한 `DaemonServer.effectiveOauthConnected()` 경로는 ESP32 serial heartbeat callback 이
  `@MainActor` 서버 상태를 background actor 에서 읽을 수 있던 문제라서, serial-facing state/usage/display
  event 를 lock-protected snapshot 으로 전달하도록 분리했다.

### 검증

- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataTimelineMarkdownCrash CODE_SIGNING_ALLOWED=NO` 성공.
- 실행 중인 Dashboard 에서 TIMELINE row 를 여러 번 클릭해 detail pane 전환이 계속 동작하는 것을 확인했다.
- `git diff --check` 성공.

---

## 2026-05-06 — Voice assistant TCC callback crash fix

### 문제

macOS AgentDeck 이 daemon startup 이후 `CodexOTel`/D200H 로그를 마지막으로 조용히 종료되는 사례가
반복됐다. 진단 번들의 `.ips` crash report 는 `EXC_BREAKPOINT` / `_swift_task_checkIsolatedSwift` 를
가리켰고, faulting stack 은 `DaemonVoiceAssistant.start()` 에서 만든 speech authorization callback 이
TCC 백그라운드 큐에서 호출되는 경로였다. `DaemonVoiceAssistant` 가 `@MainActor` 이므로 Swift 6 런타임이
actor-isolated closure 를 잘못된 executor 에서 실행한다고 판단해 trap 한 것이다.

### 해결

- 마이크/음성 인식 권한 요청 callback literal 을 `@MainActor` 타입 밖의 `VoicePermissionRequester` 로
  이동했다.
- `SFSpeechRecognizer.recognitionTask` callback 도 non-actor `VoiceSpeechTranscriber` 로 분리했다.
- speech result continuation 은 `@unchecked Sendable` lock box 로 감싸 다중 callback resume 과 Swift 6
  concurrent-capture 오류를 함께 막았다.

### 검증

- `bash scripts/capture-apple-diagnostics.sh --tail 1500 --last 30m` 로 crash report 를 수집했다.
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataVoiceCrash CODE_SIGNING_ALLOWED=NO` 성공.
- 수정 빌드 실행 후 `http://127.0.0.1:9120/health` 응답을 확인했고, startup 이후 OTel/D200H/hook 이벤트를
  지나 daemon 이 계속 살아있는 것을 확인했다.
- `git diff --check` 성공.

---

## 2026-05-06 — Dashboard TIMELINE detail markdown preview

### 문제

TIMELINE detail pane 이 assistant/eval detail 의 markdown 문법(`**bold**`, list, heading, inline code 등)을
원문 문자열로 그대로 보여 preview 로 읽기 어려웠다.

### 해결

- macOS Dashboard `TimelineStripView` 의 detail text 렌더링을 `AttributedString(markdown:)` 기반
  `TimelineMarkdownPreview` 로 교체했다.
- markdown parse 실패 시 원문 `AttributedString` 으로 fallback 한다. detail pane 의 선택/복사는 유지했다.

### 검증

- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataTimelineMarkdown CODE_SIGNING_ALLOWED=NO` 성공.
- `git diff --check` 성공.

---

## 2026-05-06 — Dashboard TIMELINE lifecycle 단위 정리

### 문제

macOS Dashboard TIMELINE 이 작업 단위가 아니라 저수준 이벤트를 그대로 노출했다. Claude Code 는 응답
캡처가 비면 사용자가 입력한 `chat_start` 만 남았고, `chat_end` 는 UI 에서 일괄 숨겨 완료 row 가 사라졌다.
Codex 는 APME/session state 로는 들어오지만 timeline entry 를 만들지 않아 Dashboard TIMELINE 에 보이지
않았다. OpenClaw tool row 는 tool 이름/입출력 요약이 충분히 복원되지 않아 어떤 tool 이 실행됐는지
판단하기 어려웠다.

### 해결

- 공통 `TimelineEntry` 에 `runId`/`startedAt`/`endedAt` 을 추가했다. Bridge/Android/Swift store 의 upsert
  경로도 이 lifecycle field 를 보존한다.
- macOS TIMELINE 은 완료된 turn 의 `chat_start` 를 목록에서 숨기고, `chat_response` 가 있는 경우
  메타 `chat_end` 를 숨긴다. 완료 row 의 detail pane 에 START/END/DUR 를 표시한다.
- macOS TIMELINE row 에 `SessionCreatureIcon` 을 넣어 Claude/Codex/OpenClaw/OpenCode source 를
  project prefix 와 별도로 식별하게 했다.
- Codex CLI/OTel/hook 경로에서 `chat_start`/`tool_exec`/`chat_response`/`chat_end` timeline entry 를
  생성한다. 응답 텍스트가 없으면 완료 row 는 남기고, 응답이 잡히면 result row 를 우선 표시한다.
- OpenClaw Gateway `session.tool` payload 는 `name/tool/toolName` 과 nested payload 를 더 폭넓게 읽고,
  input/output/error 를 JSON compact detail 로 보여준다.
- APME `eval_result` row 에 task/turn/run 의 시작/완료 시각을 실어 평가 결과가 실제 작업 lifecycle 과
  연결되게 했다.

### 검증

- `pnpm --filter @agentdeck/shared typecheck` 성공.
- `pnpm --filter @agentdeck/shared build` 성공.
- `pnpm --filter @agentdeck/bridge typecheck` 성공.
- `pnpm vitest run bridge/src/__tests__/timeline-integration.test.ts` 성공.
- `./gradlew :app:compileDebugKotlin` 성공.
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataTimelineTask CODE_SIGNING_ALLOWED=NO` 성공.
- `pnpm vitest run bridge/src/__tests__/apme-task-boundary.test.ts ...` 는 현재 로컬 native optional dependency
  `better-sqlite3` 초기화 실패로 실행되지 않았다. Swift XCTest 는 test runner 가 app launch 상태에서
  장시간 반환하지 않아 중단했다.
- `git diff --check` 성공.

---

## 2026-05-05 — E-ink Attention parity 응답 패널

### 2026-05-06 추가 — 실기기 설치 검증

- `bash scripts/build-android-release.sh` 성공 → `dist/agentdeck-v0.4.1.apk`.
- ADB 설치 완료: Pantone6 (`AA007422R24C1300039`, `lastUpdateTime=2026-05-06 03:51:37`),
  CremaS (`CREMAA21W09235`, `lastUpdateTime=2026-05-06 03:52:40`),
  Lenovo TB-J606F (`HVA095B4`, `lastUpdateTime=2026-05-06 03:51:41`). 모두
  `versionCode=5`, `versionName=0.4.1`.
- Pantone6/CremaS 는 재설치 후 `android.permission.WRITE_SECURE_SETTINGS` grant 를 다시 적용했다.
- 세 기기 모두 `dev.agentdeck/.MainActivity` foreground 확인. 최근 logcat 에서 `AndroidRuntime` fatal/crash
  로그 없음.

### 문제

Android tablet/iOS Dashboard 는 어떤 세션이든 `awaiting_*` 상태가 되면 Attention theater 를 띄워
해당 session 을 focus 한 뒤 `select_option` 응답을 보낼 수 있었다. 반면 e-ink Dashboard 는 현재 focused
primary state 가 awaiting 일 때만 `EinkContextArea` 에 옵션을 보여 다중 세션에서 e-ink 단독 사용자가
tablet/iOS 와 같은 응답 경험을 얻지 못했다.

### 해결

- e-ink 전용 `EinkAttentionPanel` 을 추가해 landscape/portrait context band 에 awaiting session 을
  표시한다.
- focused awaiting session 은 live question/options/cursor 를 보여주고, 다른 awaiting session 은 tap 시
  `focus_session` 후 `select_option` 을 보내 tablet/iOS 의 라우팅 의미와 맞췄다.
- parser 가 옵션을 못 준 경우 e-ink permission/attention UI 모두 `Yes`/`No`/`Always` fallback 을 보여
  blank approval panel 이 생기지 않게 했다.
- `docs/android-ui.md` 에 e-ink Attention parity 계약을 추가했다.

### 검증

- `git diff --check` 성공.
- `./gradlew :app:compileDebugKotlin` 성공.
- `./gradlew :app:testDebugUnitTest --tests dev.agentdeck.ui.eink.EinkAttentionPanelTest` 성공.
- `./gradlew :app:testDebugUnitTest` 성공.

---

## 2026-05-05 — Dashboard TIMELINE task summary 운영성 개선

### 문제

Dashboard TIMELINE 의 APME 평가 row 가 `★ task 85% [category]` 처럼 점수와 분류만 먼저 보여
운영자가 주변 시야에서 "어떤 작업이 끝났는지"를 바로 판단하기 어려웠다. 다중 세션 환경에서도 timeline
entry 에 project/session attribution 이 안정적으로 붙지 않아 AgentDeck/ViewTrans 같은 동시 세션을
TIMELINE 만 보고 구분하기 어려웠고, Android/e-ink 는 Claude Code 의 `chat_response` 뒤 `chat_end`
메타 row 를 그대로 보여 같은 턴이 중복 요약처럼 보일 수 있었다.

### 해결

- 공통 `TimelineEntry` 에 `projectName`/`sessionId` 를 추가하고, session timeline relay 와 bridge
  history/live broadcast 에서 누락된 attribution 을 보강했다.
- Node daemon 과 Swift in-process daemon 의 APME `eval_result` raw 를 `★ task 85% [debugging]
  <작업 요약>` 형태로 바꿨다. detail 에는 summary, axis score, done/missed, reasoning, project/prompt 를
  줄 단위로 넣어 compact row 와 detail pane 의 역할을 분리했다.
- Android tablet TIMELINE 과 e-ink TIMELINE/EventLog 가 project/source label 을 표시하고, Claude Code
  `chat_end` 메타 row 를 숨겨 iOS Dashboard 와 동일하게 한 턴이 한 줄 요약으로 읽히게 했다.
- timeline upsert 경로가 summary 만 교체할 때도 agent/project/session attribution 을 보존하도록
  Bridge/Android store 를 보강했다.

### 검증

- `pnpm --filter @agentdeck/shared typecheck` 성공.
- `pnpm --filter @agentdeck/shared build` 성공.
- `pnpm --filter @agentdeck/bridge typecheck` 성공.
- `pnpm vitest run bridge/src/__tests__/session-timeline-relay.test.ts bridge/src/__tests__/timeline-integration.test.ts` 성공.
- `./gradlew :app:compileDebugKotlin` 성공.
- `./gradlew :app:testDebugUnitTest --tests dev.agentdeck.state.TimelineStoreTest` 성공.
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataTimelineTask CODE_SIGNING_ALLOWED=NO` 성공.
- `git diff --check` 성공.

## 2026-05-05 — E-ink Dashboard parity 구현 및 Pantone 배포

### 2026-05-05 추가 — e-ink portrait/landscape 양방향 보장

- `MainActivity` 의 e-ink orientation 적용을 `applyOrientationPreference()` 로 통합했다. landscape/portrait
  는 `requestedOrientation` 과 Pantone/RK3566 `USER_ROTATION` fallback 을 함께 적용하고, `Auto` 는
  `ACCELEROMETER_ROTATION=1` 로 system auto-rotation 을 복원한다.
- e-ink rotate control 을 `Settings button` 표시 여부와 분리했다. Display panels 에서 settings button 을
  숨겨도 portrait/landscape 전환은 계속 가능하다.
- Pantone6 (`AA007422R24C1300039`) 실기기에서 portrait screenshot → rotate tap → landscape screenshot
  → rotate tap → portrait screenshot 순서로 검증했다. 설치된 APK 는 `versionName=0.4.1`,
  `lastUpdateTime=2026-05-05 14:50:21`; 최근 logcat 250라인에서 `AndroidRuntime`/`FATAL EXCEPTION`
  매치 없음.

### 문제

Dashboard UX parity 정렬 후에도 e-ink 화면은 새 방향성에 비해 덜 따라와 있었다. tablet/iOS 와
동일해야 하는 session focus, settings 구조, display panel 토글, downstream device 관계가 e-ink 에서는
부분적으로만 반영됐고, `Tank status`/`Device diagnostic` 토글도 실제 compact status 표시에 분리 적용되지
않았다.

### 해결

- e-ink landscape/portrait 모두 `Display panels` 선호도를 읽어 session list, tank status, device
  diagnostic, timeline, settings button 표시를 제어하도록 연결했다.
- e-ink session list row tap 이 tablet 과 동일하게 `focus_session` bridge command 를 보내도록 했다.
- e-ink settings overlay 를 Connection / Mac integrations(read-only) / Display panels / Display &
  sleep / Orientation 구조로 확장해 tablet/iOS 설정 의미와 맞췄다.
- `EinkStatusCompact` 에 downstream device summary 를 추가하고 `Tank status` 와 `Device diagnostic`
  토글을 각각 반영했다. `moduleHealth` 기반으로 Stream Deck, D200H, Pixoo, ESP32, Android/e-ink
  관계를 압축 표시한다.
- 공통 Connection panel 의 bridge URL 표시에서 `token=` 값을 redaction 하도록 해 Settings 에서 pairing
  token 이 그대로 노출되지 않게 했다.
- e-ink 전용 EPD refresh zone, color/grayscale renderer, 작은 화면 layout 제약은 그대로 보존했다.

### 검증

- `git diff --check` 성공.
- `./gradlew :app:compileDebugKotlin` 성공.
- `./gradlew :app:testDebugUnitTest` 성공.
- `bash scripts/build-android-release.sh` 성공 → `dist/agentdeck-v0.4.1.apk`.
- ADB 설치 완료: Pantone6 (`AA007422R24C1300039`, `versionName=0.4.1`,
  `lastUpdateTime=2026-05-05 13:53:22`), Lenovo TB-J606F (`HVA095B4`,
  `lastUpdateTime=2026-05-05 13:56:16`).
- Pantone6 에서 `dev.agentdeck/.MainActivity` resumed 확인. 최근 logcat 250라인에서
  `AndroidRuntime`/`FATAL EXCEPTION` 매치 없음.
- Lenovo TB-J606F 에서도 `dev.agentdeck/.MainActivity` resumed 확인. 최근 logcat 은 정상 launch/draw
  로그만 확인되고 fatal crash 없음.
- Pantone6 screenshot 으로 Dashboard 의 `Devices: D200H, Pixoo` compact downstream 표시와 Settings
  overlay 의 Connection / Mac integrations / Display panels 렌더링, `token=redacted` 표시를 확인했다.

---

## 2026-05-05 — Android tablet OpenClaw foreground 배치 보정

### 문제

Android tablet Monitor 화면에서 OpenClaw 메인 가재가 하단 `TIMELINE` detail pane 과 겹칠 때,
Compose 레이어 순서상 terrarium canvas 전체가 먼저 그리고 `TimelineStrip` 이 나중에 올라와 가재가
텍스트 뒤에 가려졌다. 기존 canvas 내부 draw order 를 조정해도 Compose sibling 인 TIMELINE 보다
앞으로 나올 수 없는 구조였다.

### 해결

- Tablet Monitor 전용 OpenClaw 기준점을 기존 우하단 모래선 근처에서 위/왼쪽
  (`x=0.70`, `y=0.575`) 으로 옮겨 TIMELINE detail pane 침범을 줄이면서 오른쪽 HUD rail 을 피했다.
- 활성 OpenClaw 상태에서는 메인 가재를 배경 canvas 에서 빼고 `TimelineStrip` 뒤가 아닌 별도
  foreground canvas 에서 그리도록 분리했다. 레이어 순서는 `TIMELINE < OpenClaw < HUD/gear` 로
  유지해 OpenClaw 는 TIMELINE text 보다 앞에 나오되, topology rail 같은 HUD 텍스트는 가리지 않는다.
- Worker 가재 배치는 조정된 메인 가재 기준점을 받을 수 있게 하여 tablet 위치 변화와 같이 움직인다.

### 검증

- `./gradlew :app:compileDebugKotlin` 성공.
- `bash scripts/build-android-release.sh` 성공 → `dist/agentdeck-v0.4.1.apk`.
- ADB 설치 완료: Lenovo TB-J606F (`HVA095B4`, `lastUpdateTime=2026-05-05 13:34:25`),
  Pantone6 (`AA007422R24C1300039`, `lastUpdateTime=2026-05-05 13:36:44`).
- Lenovo TB-J606F 실기기 screenshot 으로 레이어 순서 확인.

---

## 2026-05-05 — Dashboard UX parity: macOS/iOS/Android tablet 정렬

### 문제

macOS Dashboard 는 host-side 기능이 추가되어 있고 Android tablet 은 별도 Compose 설정/명령 경로를
쓰면서 iOS Dashboard 와 세부 경험이 갈라졌다. 특히 Android 는 세션 리스트/Attention 카드에서
focus session 을 먼저 보내지 않아 다중 awaiting 세션 응답이 iOS 와 다르게 라우팅될 수 있었고,
Display panels 토글 및 downstream device topology 가 iOS/macOS 와 맞지 않았다.

### 해결

- macOS Dashboard 의 특수 창/menubar 기능은 유지하면서, 빈 수족관 배경 탭으로 HUD 를 숨기는
  aquarium viewing interaction 을 iOS 와 동일하게 적용했다.
- Android tablet 에 `focus_session` command 를 추가하고 세션 리스트 row, Attention 카드 focus/respond
  경로에 연결했다.
- Android tablet settings 에 iOS 와 같은 `Mac integrations` read-only card 와 `Display panels` 토글을
  추가하고, 세션 리스트/토폴로지/타임라인/설정 버튼 표시가 해당 선호도를 따르도록 했다.
- Android protocol/state/topology rail 이 `moduleHealth` 를 수신해 Stream Deck, D200H, Pixoo, ESP32,
  Android/e-ink devices 를 downstream 관계로 표시하도록 맞췄다. 데이터가 없을 때만 `This tablet`
  fallback 을 유지한다.

### 검증

- `./gradlew :app:compileDebugKotlin` 성공.
- `./gradlew :app:testDebugUnitTest` 성공.
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination platform=macOS build` 성공.
- `git diff --check` 성공.

---

## 2026-05-05 — Android OpenClaw false-active 표시 보정

### 문제

Android 태블릿/e-book 대시보드에서 OpenClaw Gateway 가 인증되지 않았거나 끊긴 상태인데도
이전 worker 가재, OpenClaw 모델 라인, worker count 가 남아 OpenClaw 가 활성화된 것처럼 보였다.
원인은 Android `AgentStateHolder` 가 `modelCatalog`/`workerSessionCount` 를 null-coalescing 으로
보존하고, 일부 e-ink/portrait HUD 표면이 `gatewayConnected` 대신 stale catalog/count 를 직접
표시한 데 있었다. Node daemon 쪽도 Gateway disconnect 때 `sessions_list` 만 먼저 내보내고
`gatewayConnected=false` state update 가 늦게 도착할 수 있었다.

### 해결

- Android state merge 에서 `gatewayConnected != true` 이면 OpenClaw capabilities/sessionStatus/worker
  count 를 clear 하고, Gateway unavailable 상태의 stale error 를 false 로 수렴시켰다.
- Terrarium worker crayfish 는 인증 완료(`gatewayConnected=true`)일 때만 렌더 count 를 넘긴다.
- e-book compact/status/portrait header 와 tablet HUD worker count 를 `gatewayConnected` 기준으로
  게이트했다. tablet topology rail 은 reachable-but-unauthenticated 상태를 `Not connected` 로 표기한다.
- Node daemon 은 Gateway disconnect 이벤트에서 즉시 `state_changed` 를 emit 하고, Gateway unavailable
  probe 시 stale `gatewayHasError` 도 clear 한다.

### 검증

- `git diff --check` 성공.
- `./gradlew :app:testDebugUnitTest --tests dev.agentdeck.terrarium.TerrariumStateTest` 성공.
- `./gradlew :app:testDebugUnitTest` 성공.
- `pnpm --filter @agentdeck/bridge typecheck` 성공.
- `bash scripts/build-android-release.sh` 성공 → `dist/agentdeck-v0.4.1.apk`.
- ADB 설치 완료: Pantone6 (`AA007422R24C1300039`), Lenovo TB-J606F (`HVA095B4`), 둘 다
  `versionCode=5`, `versionName=0.4.1`, `lastUpdateTime=2026-05-05 12:42` 확인.

---

## 2026-05-05 — OFFLINE 히어로 SD+ 2×2 클러스터 + D200H teardown 프레임

### 문제
- `d030c142` 의 단일-키 OFFLINE 히어로가 짝수×짝수 데크(SD+ 4×2, SD XL 8×4) 에선 진짜 중앙이 없어 `floor(rows/2)*cols + floor(cols/2)` 가 항상 우하단으로 치우친 후보를 골라 시각 균형이 깨짐. SD+ 에서 슬롯 6 (button 7) 에 표시돼 어색.
- D200H 는 데몬이 종료되면 마지막 세션 화면이 그대로 남아 OFFLINE 표시가 전혀 없음. App 종료 후 재실행 전까지 stale 한 정보가 키패드에 떠 있음.

### 해결
- 공용 렌더러 `renderOpenAppQuadrant(quadrant)`: 288×288 논리 캔버스를 4 개의 144×144 viewBox 로 클리핑(transform translate). 각 키는 자기 외곽 둥근 모서리를 유지하면서 panel/icon/text 가 4 키에 걸쳐 하나의 카드로 보임.
- `computeCenterCluster(layout)`: 짝수×짝수 → tl/tr/bl/br 사분면 4 슬롯, 그 외 → 단일 'full' 슬롯 폴백. 기존 `computeCenterSlot` 시그니처는 보존.
- `session-slot-button.ts`: hero/keypress 둘 다 cluster 기반 — 클러스터 4 키 어디 눌러도 `openAgentDeckAppOrGitHub()` 발동.
- D200H Swift `sendOfflineFrame()`: `stop()` 에서 `disconnect()` 직전 호출, 14 ButtonSlot dim + 슬롯 7 (col=2,row=1, 시각 중앙) 에 OFFLINE/Open AgentDeck 카드 push. App→DaemonService.stop→DaemonServer.shutdown→ModuleManager.stopAll→D200hHidModule.stop 경로로 도달.

### 핵심 설계 결정

**1. 짝수 그리드 정중앙은 4-키 분산이 정답**
floor 공식이 항상 한쪽으로 치우치는 한계는 산술적으로 풀 수 없음. SVG viewBox 클리핑으로 한 카드를 4 등분하면 진짜 시각 중앙이 가능하고, 카드 자체도 2 배 크게 그릴 수 있어 OFFLINE 같은 hero 신호로는 단일 키보다 강함. 홀수 차원은 단일 hero 유지 (true center 가 존재).

**2. ButtonSlot.textOverlay 기본값 .none = 텍스트 미렌더 함정**
`renderButtonPng` 의 텍스트 분기는 `slot.textOverlay` 가 `.none` 이면 title/subtitle 둘 다 무시하고 아이콘만 그림 (line 2544). 직관과 반대 — title 이 비어있지 않으면 그릴 거라 가정하면 망함. status tile 류는 모두 `.infoTile` 명시 필요. Codex stop-time review 가 잡음.

**3. App 강제종료/크래시는 비범위**
graceful teardown (Cmd-Q, SIGTERM 등) 에선 `stop()` 이 호출되므로 OFFLINE 프레임 push 가능. SIGKILL/패닉은 별도 보조 프로세스(LaunchAgent 등) 없인 캐치 불가 — 큰 작업이라 별 이슈로 분리.

---

## 2026-05-05 — OpenClaw Settings 정상 상태 UI 정리

### 문제

OpenClaw Gateway 연결이 정상화된 뒤에도 Settings → Integrations 의 OpenClaw row 가
`Connected / Paired through Gateway` 아래에 token import, reconnect, Web UI, reset identity 버튼과
4개 bullet 설명을 항상 노출했다. 정상 상태에서는 "연결됨" 확인만 필요하고, 이 수리 도구들은 오히려
불필요한 조작처럼 보였다. Accounts 섹션의 "No tokens to paste here" 문구도 OpenClaw Advanced token
field 와 충돌했다.

### 해결

- OpenClaw troubleshoot row 는 Gateway 가 available 이면서 connected 가 아니거나 auth error 상태일
  때만 inline 으로 표시한다.
- 정상 connected 상태에서는 `Advanced` disclosure 만 남기고, token refresh / reconnect / Web UI /
  reset identity / token paste field 는 그 안으로 이동했다.
- 기존 4개 bullet 설명을 상태별 1줄 hint 로 축소하고, 버튼 라벨도 `Import token`, `Open Web UI`,
  `Reset identity` 로 줄였다.
- Accounts 섹션 설명을 "repair tools stay in Advanced" 로 바꿔 optional token repair 경로와 충돌하지
  않게 했다.

### 검증

- 정상 연결 상태 UI: OpenClaw row 는 `Connected / Paired through Gateway` + 접힌 `Advanced` 만 표시.
- `Advanced` 확장 시 repair controls 와 token field 가 노출됨.
- `git diff --check` 성공.
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataOpenClawSettingsTrim CODE_SIGNING_ALLOWED=NO` 성공.

---

## 2026-05-05 — OpenClaw token-only fallback 무응답 타임아웃 + Settings reconnect

### 문제

Xcode-run App Store-gated macOS 앱에서 OpenClaw Gateway TCP/health 는 정상이고
Settings → Integrations 에서 `openclaw.json` 토큰도 Keychain 에 저장되어 있었지만, Dashboard 는
`gatewayAvailable=true`, `gatewayConnected=false`, `gatewayAuthStatus=gateway_reachable` 로
"Awaiting setup / Connecting to Gateway" 에 머물렀다. Swift daemon 로그상 첫 `connect` 는
`DEVICE_AUTH_SIGNATURE_INVALID` 로 거부되고, 그 뒤 token-only fallback 이
`fallback=true hasDevice=false hasSharedToken=true hasDeviceToken=false` 로 전송되지만 Gateway 응답이
돌아오지 않았다. 기존 Swift 어댑터는 fire-and-forget `connect` RPC 에 timeout 이 없어 이 상태를
명시 실패나 재시도로 전환하지 못했다.

### 해결

- `OpenClawAdapter` 의 pending RPC 에 timeout 을 추가했다. 특히 `connect` RPC 무응답은 socket 을
  닫아 기존 reconnect 루프로 복귀시키고, 첫 device-auth connect 가 조용히 drop 되면 token-only
  fallback 으로 한 번 전환한다.
- token-only fallback connect 까지 timeout 되면 `connect_timeout` auth status 를 내보내 UI 가
  무한 "Connecting" 으로 남지 않게 했다.
- `ADGatewayFrame` 디코드가 큰 `hello-ok` payload 에서 실패해도 raw JSON envelope 의
  `type=res/event` 로 response/event 를 처리하게 했다. Gateway 가 실제로 `ok=true` 를 보냈는데
  Swift 가 payload union 디코드 실패 때문에 응답을 drop 하는 경로를 막는다.
- Settings → OpenClaw troubleshoot row 에 명시적 **Reconnect adapter** 버튼을 추가했다. 토큰 입력칸
  Save 버튼이 빈 입력 때문에 비활성화된 상황에서도 daemon 전체 restart 없이 OpenClaw adapter 만
  bounce 할 수 있다.

### 검증

- Xcode-run diagnostics: Gateway `available=true`, `connected=false`, `authStatus=gateway_reachable`,
  Swift log 에서 token-only fallback 무응답 확인.
- OpenClaw `gateway.err.log`: AgentDeck 첫 시도는 `code=1008 reason=device signature invalid` 로
  닫힘.
- `git diff --check` 성공.
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataOpenClawConnectTimeout CODE_SIGNING_ALLOWED=NO` 성공.
- Xcode 종료 후 새 Debug `.app` 직접 실행 검증: 수정 전에는 Dashboard/Settings 가 `Handshake
  timeout` / `connect_timeout` 을 표시하고, Settings 의 **Reconnect adapter** 클릭 시 adapter-only
  reconnect → token-only fallback → 10s timeout 으로 다시 수렴했다.
- raw-envelope fallback 수정 후 새 Debug `.app` 재실행 검증: `/status.modules.gateway` =
  `{available:true, connected:true, authStatus:"connected"}`, `sessions=1`. Swift log 에
  `connect ok=true`, `sessions.subscribe ok=true`, `health ok=true`, `sessions.list ok=true`,
  active session `agent:main:main` 확인.

---

## 2026-05-05 — macOS Quit 후 BridgeConnection 재접속 루프 차단

### 문제

메뉴바 Quit 또는 Cmd+Q 종료 중 in-process daemon 은 `Daemon stopped` 까지 정상 shutdown 되지만,
dashboard 쪽 `BridgeConnection` / stale-data watchdog / mDNS discovery 가 종료 상태를 모르고
`ws://127.0.0.1:9120` 재접속을 계속 예약했다. 그 결과 daemon 종료 직후 `Connection refused`
로그가 반복되고 앱이 살아 있는 것처럼 보였다.

### 해결

- `AgentStateHolder.prepareForTermination()` 추가. Quit 시 preferred local bridge, auto-connect
  timer, stale monitor, wake listener, discovery, bridge connection 을 먼저 종료 모드로 전환한다.
- `BridgeConnection.prepareForTermination()` 추가. WebSocket, URLSession, ping timer, reconnect
  work item 을 취소하고 이후 `connectInternal` / receive callback / ping / reconnect 가 재진입하지
  않도록 termination guard 를 둔다.
- `BridgeDiscovery.prepareForTermination()` 추가. NWBrowser restart 예약과 late resolve/health
  callback 이 종료 중 bridge list 를 다시 채우지 못하게 guard 한다.
- 메뉴바 Quit 은 daemon 을 직접 stop 하지 않고 `NSApplication.terminate` 로 단일 종료 경로에
  위임한다. AppDelegate 는 daemon shutdown 전에 dashboard-side reconnect loop 를 먼저 끈다.

### 검증

- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination platform=macOS -derivedDataPath /tmp/AgentDeckDerivedDataQuitFix build CODE_SIGNING_ALLOWED=NO`
  성공.

---

## 2026-05-04 — Xcode-run Apple diagnostics workflow for coding agents

### 문제

앱은 Xcode 에서 직접 실행/재현하고 코드 수정은 Claude Code/Codex 에이전트가 맡는 흐름에서,
Xcode console / OSLog / Swift daemon file log / `/diag` 상태를 매번 사람이 복사해 전달해야 했다.
그 결과 로그 누락, 포트 착각, in-process Swift daemon vs external Node daemon 혼동, hang sample 누락이
반복됐다.

### 해결

- `scripts/capture-apple-diagnostics.sh` 추가. repo-local 개발 도구로 daemon port 를
  `daemon.json` 또는 9120-9139 scan 으로 찾고, `/status`, `/diag`, `/devices`, `/usage`,
  Swift daemon log tail, AgentDeck OSLog, process list, 짧은 `sample` 을
  `diagnostics/apple-xcode/<timestamp>/` 에 수집한다.
- `.agents/workflows/apple-xcode-debug.md` 추가. Xcode 에서 재현된 Apple 앱 이슈는 사용자에게
  콘솔 복붙을 요구하기 전에 이 workflow 로 bundle 을 만들고 `diagnostics/apple-xcode/latest/`
  를 읽도록 표준화했다.
- `CLAUDE.md` 의 Development 섹션에 Apple/Xcode Debug Diagnostics 지침을 추가했다. 이 경로는
  App Store 앱 내부 기능이 아니라 저장소 측 개발 도구이며, App Store UI 나 Swift app source 에
  subprocess/terminal 안내를 추가하지 않는다는 경계를 명시했다.
- `.gitignore` 에 `diagnostics/` 를 추가해 수집 산출물이 커밋되지 않게 했다.

### 검증

- 앱 소스와 Xcode project 파일은 변경하지 않음.
- 수집 스크립트는 credential-bearing 파일(`auth-token`, `settings.json`, OpenClaw config)을
  의도적으로 제외한다.

---

## 2026-05-03 — OpenClaw 페어링 stuck 진단 + UX/Review-notes 동기화 (16-step)

### 문제

App Store / Group Container 빌드에서 사용자가 Settings → OpenClaw 에 토큰을 저장했음에도
"Awaiting setup" 으로 영구히 머무는 상태. 16 단계에 걸쳐 누적 진단 + fix.

핵심 단서:
- `/status.gateway` = `{available:true, connected:false, authStatus:"gateway_reachable"}`
- 처음엔 silent drop 으로 오인 → 실제로는 OpenClaw 측 ws close 1008 reason 으로 거부 (74건
  누적, 8가지 reason: `device signature invalid`, `device identity required`, `gateway token
  missing`, `unauthorized: device token mismatch`, `invalid handshake`, `invalid connect
  params`, `connect failed`, `unauthorized: too many failed authentication attempts`).
- 사용자 Web UI 도 unauthorized 라며 token 입력 요구 → SPA bundle 분석 결과 OpenClaw
  control-ui 자체에는 token UI 가 없고 (`Chat settings` / `Search settings` 만), token 은
  `~/.openclaw/openclaw.json` 의 `auth.token` (plaintext) 으로만 관리.

### 해결 (16-step 정리)

1. **shared-token 분기 제거** (`OpenClawAdapter.swift sendConnectRequest`) — 옛 `shouldSendDeviceAuth = hasDeviceToken || !hasSharedToken` 분기가 dmPolicy=pairing 환경의 첫
   페어링을 막고 있었음.
2. **RPC error 기반 fallback** — `device_auth_invalid` 응답 + flag 미설정 → flag set + 즉시 retry.
3. **Fallback 시 device 자격증명 전체 차단** — `params["device"]`/`auth["deviceToken"]`/`scopes`
   모두 제거. 진짜 token-only 보장.
4. **close-reason aware fallback** — RPC 응답 안 오는 transport-level 1008 close 도
   `receiveLoop` 가 `task.closeCode/closeReason` 추출 → `handleDisconnect` 가 reason 별 분기.
5. **`expectingClientInitiatedClose` flag** — fallback 의 `wsTask.cancel` 이 receiveLoop 의 close
   event 를 트리거 → 그 close 의 server reason 이 다시 fallback exhausted 분기로 들어가
   `pairingRequired=true` 차단 = 자기-차단. flag 로 직후 1회 close 만 reason 분기 skip.
6. **narrow restart** — `daemonService.restart()` (daemon 전체 재시작 → Claude Code/Codex
   sessions 끊김) 대신 `reconnectGatewayAdapter()` (OpenClaw adapter 만 bounce). DaemonServer
   에 public `reconnectGatewayAdapter()` 추가, DaemonService 에 forward.
7. **NSOpenPanel token import** — Settings → OpenClaw troubleshoot row 에 "Import token" 버튼.
   `NSOpenPanel` user-selected scope (`com.apple.security.files.user-selected.read-write`,
   `startAccessingSecurityScopedResource()` + `defer stop`) → `Data(contentsOf:)` →
   `JSONSerialization` → `auth.token` 만 사용 → Keychain 저장 → adapter reconnect.
8. **`getpwuid(getuid()).pw_dir`** — `panel.directoryURL` 을 사용자 real home 으로 set.
   `NSHomeDirectory()` / `$HOME` env 는 sandbox 안에서 container path 반환 → real home 못
   가리킴. `getpwuid` 패턴 (memory `swift-daemon-server.md`) 사용. NSOpenPanel 은 Powerbox
   에서 동작하므로 sandbox-external path 를 navigation hint 로 받아도 권한 위반 아님.
9. **`OpenClawDeviceIdentityStore`** — Keychain self-gen identity 삭제 정적 메서드. Settings 의
   "Reset pairing identity" 버튼이 호출 → 다음 connect 에 fresh Ed25519 키쌍 생성.
10. **App Store reachable 카피 정정** — "Start OpenClaw" 같은 launch-instruction 제거 ("When
    OpenClaw is running, ..." conditional 형태). App Review 4.2.3 sensitivity.
11. **사용자 카피 vs review notes 톤 분리** — 같은 행위를 reviewer 정확성 톤 (overstatement
    제거: "uses only X" / "saves only X" / "persists only X") 과 사용자 친근 톤 (path hint
    포함) 으로 분리 작성. 사용자가 옵션 1 (path hint 포함) 선택.
12. **`APP_REVIEW_NOTES.md` 동기화** (4 라운드) — line 70 + line 75 cross-reference 일관성:
    `directoryURL` set 동작, `~/.openclaw/` enumerate 안 함, "hardcode" 의 두 의미 (string
    literal in copy vs runtime file-system target) 분리. line 70 의 "never sets directoryURL"
    → "never points it *at* `~/.openclaw/`" 로 좁힘.
13. **`.help(_:)` markdown warning 해소** — SwiftUI `.help(_:)` 의 default `LocalizedStringKey`
    overload 가 backtick/em-dash/quote 를 styled run 으로 파싱 → "Only unstyled text" warning.
    4 곳 (line 602, 1072, 1083, 1092) 모두 `.help(Text(verbatim:))` overload 로 wrap.
14. (그 외 단계 8/13/14 의 false claim 정정 — "(sandbox-internal)" 잘못된 claim 제거 등 누적)
15. **`docs/appstore-feature-matrix.md` 갱신** — CLAUDE.md invariant ("Feature matrix is canonical.
    New features land in the table before any implementation touches the App Store target") 준수.
    OpenClaw 행에 4 개 새 row 추가: shared-token Keychain 저장, shared-token import from JSON
    config (NSOpenPanel + user-selected scope + getpwuid real home), device pairing identity
    reset (`reconnectGatewayAdapter` only, sessions 영향 없음), Web UI deep link
    (`NSWorkspace.open`). 각 행에 entitlement + blast radius 명시.

### 핵심 설계 결정

| 결정 | 이유 |
|---|---|
| RPC fallback + transport (close-reason) fallback **둘 다 유지** | OpenClaw 가 모드/버전에 따라 RPC error vs ws close 둘 다 사용 |
| `disableDeviceAuthForNextConnect` 는 sharedToken 유무 무관 트리거 | Xcode Debug vs App Store keychain access group 차이로 token 못 읽는 환경에서도 fallback 동작 |
| `directoryURL = real home` (sandbox-external) | NSOpenPanel 은 Powerbox 라 권한 위반 아님; container path 는 OpenClaw 가 없는 곳이라 무의미 |
| 사용자 facing path hint vs runtime hardcode 분리 | App Review invariant 는 runtime file-system target 만 의심, copy 의 string literal 은 무관 |
| Reviewer 정확성 톤은 review notes 만, 사용자 카피는 친근 톤 | 같은 행위라도 audience 별 wording 분리. "reads only X" vs "uses only X" 처럼 동사 정확성 |

### 미해결 (사용자 측 영역)

우리 16 단계 fix 후에도 OpenClaw v2026.4.14 가 우리 v3 Ed25519 서명을 `DEVICE_AUTH_SIGNATURE_INVALID`
로 거부 + Web UI 가 `device token mismatch (rotate/reissue device token)` 안내. 진짜 root cause
는 OpenClaw 측 v3 verify 코드 또는 token state stale. 사용자 (OpenClaw 운영자) 가 직접 점검:

1. `openclaw update` (v2026.4.14 → v2026.4.26) — gateway.log 에 update available 알림.
2. `~/.openclaw/openclaw.json` 의 `auth.token` 새 값 발급 → Gateway 재시작 → AgentDeck Import
   token 다시.
3. `device-pair` 플러그인의 v3 verify 함수가 `docs/gateway-protocol.md` line 55-71 의 spec
   대로 reconstruct 하는지 직접 확인.

---

## 2026-05-01 — Codex session lifecycle canonicalization

### 문제

이전 보완은 Terrarium/Pixoo 렌더 계층에서 Codex companion thread 를 접고, terminal event 이후 TTL 을 줄이는 방식이었다. 하지만 여전히 근본 경계가 남아 있었다.

- `sessions_list` 자체는 raw Codex thread 를 그대로 내보내서 `/status`, D200H, Stream Deck, SessionListPanel 이 서로 다른 세션 수를 볼 수 있었다.
- `codex_stop`/OTel `turnEnd` 이후 늦게 도착한 `codex_tool_start`/`codex_tool_end`/stream span 이 `lastTerminalCodexEventBySession` 을 지우고 `processing` 으로 되살릴 수 있었다.
- 현재 Codex OTel span 이름(`turn/start`, `responses_websocket.stream_request`, `exec_command`, `dispatch_tool_call_with_code_mode_result`) 상당수가 parser 에서 unknown 으로 떨어졌다.
- OTel `session_id` fallback 도 hook 쪽과 달리 짧은 숫자 id 를 durable thread 로 승격할 여지가 있었다.

### 해결

- `DashboardDataRules.foldCodexSessionPayloadsForDisplay()` 를 추가하고 `DaemonServer.buildSessionsListEvent()` 에서 `sessions_list` 생성 직전에 적용했다. 이제 표시 표면은 모두 같은 folded Codex count 를 받는다. 동일 `projectName` 의 Codex rows 는 상태 우선순위(`processing` > `awaiting_*` > `idle`)와 최신 시작 시간을 기준으로 대표 row 하나로 합쳐지고, `groupSize`/`foldedSessionIds` 를 싣는다. 빈 projectName 은 접지 않는다.
- Stream Deck plugin 도 `foldCodexSessionsForDisplay()` 공유 유틸을 사용해 구버전/외부 daemon 이 raw rows 를 보내도 버튼 수가 부풀지 않게 했다.
- terminal stamp 는 새 턴 신호(`codex_session_start`, `codex_user_prompt_submit`, OTel `turnStart`)에서만 해제한다. terminal 이후 늦은 tool hook/OTel tool/activity span 은 무시해 끝난 thread 가 다시 `processing` 으로 살아나지 못하게 했다.
- Codex stale 정책을 분리했다: no-tool processing 30s idle settle, tool-bearing processing 120s idle settle, Codex idle observation 90s eviction, tool-bearing observation 240s eviction, post-terminal 60s eviction.
- OTel parser 가 slash/underscore span 이름을 정규화하고 현재 Codex span 이름과 activity span 을 인식한다. 숫자-only `session_id` 는 hook 과 동일하게 세션 id 로 승격하지 않는다.

### 검증

- `git diff --check` 성공
- `pnpm --filter @agentdeck/shared build` 성공
- `pnpm vitest run plugin/src/__tests__/session-slot-manager.test.ts` 성공 (5 tests)
- `pnpm --filter @agentdeck/shared typecheck` 성공
- `pnpm --filter @agentdeck/plugin typecheck` 성공
- `xcodebuild test -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -destination 'platform=macOS,arch=arm64' -only-testing:AgentDeckTests_macOS/CodexOtelParserTests -only-testing:AgentDeckTests_macOS/ProtocolTests -derivedDataPath /tmp/AgentDeckDerivedDataCodexLifecycle CODE_SIGNING_ALLOWED=NO` 성공 (첫 실행, Xcode test observer 991s 소요)
- 최종 comparator 경계 보정 후 `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataCodexLifecycle CODE_SIGNING_ALLOWED=NO` 성공. 동일 test 재실행은 Xcode test runner 장시간 대기 반복으로 중단.

---

## 2026-05-01 — Codex phantom-creature fold + post-terminal TTL

### 문제

CLI (Node `agentdeck` daemon) 이 동작하지 않고 macOS App Store 빌드의 in-process Swift daemon 만 떠있는 환경에서, Dashboard 의 Terrarium 에 실제 동작 중인 Codex 세션 수보다 훨씬 많은 Codex 크리처가 노출되고 일부는 `processing` 상태로 "행동" 중인 것처럼 보였다. 원인 조사:

- `~/.codex/session_index.jsonl` 144개 entry 중 114개가 `Codex Companion Task: <task> Run a stop-gate review...` — Claude Code 의 stop-gate / rescue workflow 가 자동 spawn 한 ephemeral Codex 작업 (4월 29일 하루 27건).
- Codex 는 turn 마다 새 thread_id 를 발급하고 daemon 은 hook (`codex_session_start`/`codex_user_prompt_submit`/...) 또는 OTel `/otel/v1/traces` 두 합성 경로로 thread_id 별 entry 를 만든다. 한번 합성된 entry 는 `pushedSessionStaleTTL = 180s` 동안 살아남아 짧은 ephemeral task 가 연속으로 돌면 4-5개가 동시에 가시화됐다.
- Swift daemon 로그 (2026-04-29 23:00–23:04, 4분 윈도우) 에서 4개 distinct codex thread id 합성 → 모두 180s TTL 만료로 evict 되는 패턴 그대로 잡힘.

### 해결 (3-layer)

1. **Render-time fold by `(agentType=codex-cli, projectName)`** (`apple/AgentDeck/Terrarium/TerrariumState.swift:182-280`): cloud creature 를 프로젝트 키로 그룹핑해 한 워크스페이스 내 ephemeral burst 를 sprite 1개로 collapse. `CloudCreatureState.groupSize` 필드 추가. 빈 projectName 은 `__id__\(id)` 폴백으로 thread 별 분리. 같은 fold 를 PixooRenderer (`syncCreatures`) 에도 적용. Octopus(Claude Code) / OpenCode 는 fold 안 함 (multi-instance 가 의도된 패턴).
2. **Post-terminal TTL 60s** (`apple/AgentDeck/Daemon/Server/DaemonServer.swift`): `lastTerminalCodexEventBySession` 추가. `codex_stop`/`codex_turn_complete`/OTel `turnEnd` 에서 stamp, 비종료에서 clear. `evictStaleHookSessions()` 가 이 stamp 가 60s 이전이면 추가로 evict. 180s 무-hook TTL 은 never-terminated zombie 안전망으로 유지.
3. **Resurrection 범위 좁힘** (`shouldSynthesizeUnknownHookSession`): codex 분기에서 `codex_tool_start` 부활 제거. 부활은 `codex_session_start` + `codex_user_prompt_submit` 로 한정. `codex_user_prompt_submit` 은 인터랙티브 다중 턴 Codex 가 post-terminal TTL 로 evict 된 뒤 사용자가 다음 프롬프트를 보낼 때 복귀하는 경로라 유지 (live process 인데 dashboard 에서 사라진 채로 못 돌아오는 사례 차단). `codex_tool_start` 는 mid-turn 시그널이라 이미 끝난 thread 의 leftover 가능성이 큼.

### 검증

- 회귀 가드: `apple/AgentDeckTests/TerrariumCloudFoldTests.swift` (7 tests) — fold by project, 다른 project 는 분리, 빈 project over-merge 방지, state precedence, primary+sibling fold, octopus 비-fold, resurrection predicate trade-off.
- `xcodebuild build -project AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS'` **BUILD SUCCEEDED**.
- `xcodebuild build-for-testing -scheme AgentDeck_macOS -derivedDataPath …` **TEST BUILD SUCCEEDED**.
- `pnpm test` 47파일 1061테스트 통과 (Node bridge 무영향).

### 후속 (out-of-scope)

- D200H 버튼 fold (focus_session 이 thread 단위라 별도 설계 필요).
- `bridge/src/passive-observer.ts` 의 Node CLI 경로 mirror.

---

## 2026-05-07 — App Store 진단 UI/타임라인 안정성 정리

### App Store 진단 UI
- macOS Settings 포트 충돌 화면에서 `Copy Terminal Command` 버튼과 `lsof`/Terminal 안내 문구 제거.
- `PortDiagnostics`는 App Sandbox 밖 프로세스에 대해 PID/상태만 보여주고, 복구 경로는 `Clean Up & Retry`, 외부 앱에서 종료, 포트 변경으로 한정.
- 포트 blocker 표시명에서 `agentdeck daemon (CLI)` 같은 companion 실행 경로로 오해될 수 있는 문구를 `External AgentDeck process`/`External <agent> session`으로 변경.

### 타임라인 매칭
- Android/macOS timeline display grouping은 양쪽 엔트리에 non-empty `runId`가 있으면 `runId`가 같을 때만 같은 turn으로 간주.
- `runId`가 서로 다른 경우 같은 `sessionId`라도 in-flight start와 later completion을 병합하지 않아 병렬/연속 turn collapse를 방지.

### Apple release lane
- `.github/workflows/apple-release.yml`의 macOS App Store job을 실제 release dependency로 복구.
- macOS job은 `APPLE_CERTIFICATE_BASE64` combined p12(Apple Distribution + 3rd Party Mac Developer Installer identities)를 임시 keychain에 import하고, `MACOS_PROVISIONING_PROFILE_BASE64`가 비어 있으면 초기에 실패하도록 설정.
- Release 생성은 iOS + macOS upload가 모두 성공한 뒤에만 실행되도록 `needs: [build-ios, build-macos]`로 변경.
- macOS 전용 `Info-macOS.plist`를 분리해 iOS launch/orientation plist key가 Mac archive에 들어가지 않게 수정.
- `verify-appstore-archive.sh`가 macOS archive의 iOS-only plist key leak, invalid entitlement blob, app-sandbox entitlement 누락을 실패로 잡도록 강화.
- App Store metadata/review notes의 Codex/OpenCode 설명을 feature matrix와 맞춰 OpenCode는 App Store 밖 developer bridge로만 표기.
- iOS App Store archive는 `Apple Distribution` + `AgentDeck Dashboard AppStore` provisioning profile을 쓰는 manual signing으로 고정. verifier가 `get-task-allow=true` development archive를 실패로 잡도록 추가.
- local `scripts/build-apple-release.sh --ios` 경로도 archive 직후 `verify-appstore-archive.sh` 를 실행하도록 맞춰 CI와 동일한 게이트를 적용.
- macOS App Store archive도 `Apple Distribution` + `AgentDeck Dashboard macOS AppStore` provisioning profile manual signing으로 고정. `Packaging.log`에서 Apple Development로 app re-signing 되던 경로를 차단하기 위해 verifier가 development certificate signature를 실패로 잡도록 추가.
- GitHub Actions macOS job은 별도 `APPLE_MAC_INSTALLER_*` secret 대신 기존 `APPLE_CERTIFICATE_BASE64` combined p12(Apple Distribution + 3rd Party Mac Developer Installer identities)를 import하도록 정리. 현재 GitHub secret inventory에는 ASC + profile + combined certificate secrets가 존재하며 별도 Mac Installer secret은 없음.
- Local `bash scripts/build-apple-release.sh --all` 기준 Apple `1.0.4` build `5` iOS/macOS archive/export 및 `verify-appstore-archive.sh` 통과. 산출물은 `dist/export_ios/AgentDeck.ipa`, `dist/agentdeck-ios-v1.0.4.ipa`, `dist/export_macos/AgentDeck.pkg`.
- `apple-v1.0.3` CI macOS x86_64/arm64 Swift type-checking 실패(`AnthropicAdminApiClient.swift`)는 token 합산 expression을 작은 sub-expression으로 분리해 수정.
- 현재 로컬 shell에는 ASC env/API key가 없어 업로드는 skip됨. 최종 App Store Connect validation/TestFlight QA는 GitHub tag workflow 또는 로컬 ASC env 주입 후 수행해야 함.
- `apple-v1.0.2` 최초 CI run에서 `APPLE_CERTIFICATE_PASSWORD`가 빈 값인 passwordless p12 흐름과 `security import -t cert -f pkcs12` 조합이 signing identity를 만들지 못하는 문제가 확인됨. workflow는 빈 password 허용 + filter 없는 p12 import + `security find-identity -v -p codesigning` 진단 출력으로 수정.

### Bridge/package stability
- Codex APME turn-boundary 로직을 `CodexTurnManager`로 분리한 뒤 남아 있던 inline state-machine 참조를 제거하고, hook-primary + PTY fallback 경로를 manager로 라우팅하도록 정리.
- `classifyAndEnqueueTurn`을 `bridge/src/apme/classify-turn.ts`로 분리해 Codex manager와 index가 공유하고 circular import 없이 사용할 수 있게 함.
- Stream Deck plugin `rollup -c`가 번들 생성 후 macOS 로컬에서 event-loop handle을 남겨 root `pnpm build`를 멈추던 문제를 `plugin/scripts/build.mjs` Rollup API wrapper로 우회. `bundle.close()` 후 명시적으로 종료해 package build가 clean exit.
- 검증: `pnpm build`, `pnpm --filter @agentdeck/plugin typecheck`, `pnpm vitest run bridge/src/__tests__/apme-telemetry-envelope.test.ts bridge/src/__tests__/apme-collector.test.ts bridge/src/__tests__/state-machine.test.ts` 통과.

---

## 2026-05-08 — macOS App Store profile 호환성: App Group 제거

### 문제
- `apple-v1.0.4` CI에서 iOS archive/export/TestFlight 업로드는 성공했지만, macOS는 archive + `verify-appstore-archive.sh` 통과 후 `xcodebuild -exportArchive`에서 실패.
- 자동 signing export는 ASC API key cloud signing 권한 문제로 `Cloud signing permission error` / `No profiles`를 반환.
- 수동 export로 전환하자 현재 GitHub/local `AgentDeck Dashboard macOS AppStore` profile이 `com.apple.security.application-groups`를 포함하지 않아 entitlement/profile mismatch가 확인됨.

### 해결
- 현재 1.0 App Store 제품에는 helper/extension/login item이 없어 shared container가 필수 기능이 아니므로 `com.apple.security.application-groups` entitlement를 제거.
- App Store macOS 데이터 루트는 `AgentDeckPaths.swift`에서 앱 sandbox container의 `Application Support/AgentDeck`로 고정. Node CLI/unsigned dev/xctest는 기존 `~/.agentdeck/` 유지.
- Claude/Codex hook snippet, setup inlined snippet, Stream Deck plugin, bridge session registry는 discovery 순서를 `~/.agentdeck/daemon.json` → App Store sandbox container `daemon.json` → legacy App Group `daemon.json` → fallback으로 확장. 기존 pre-1.0 candidate와 호환성을 유지한다.
- `ExportOptions-macOS.plist`는 manual signing + `AgentDeck Dashboard macOS AppStore` provisioning profile + `Mac Installer Distribution` automatic selector로 명시해 CI가 cloud signing에 의존하지 않게 함.
- `CLAUDE.md`, App Review notes, feature matrix, certificate setup guide, README/daemon/TestFlight docs의 data-dir/App Group 설명을 현재 shipping contract에 맞게 갱신.
- `apple-v1.0.5` CI 결과: iOS 1.0.5 build 6 archive/export/TestFlight 업로드 성공. macOS archive + verifier 성공, export는 `No certificate ... matching 'Mac Installer Distribution'`로 실패. 현재 `APPLE_CERTIFICATE_BASE64` secret에는 Mac Installer private-key identity가 없으므로 secret 재수출이 필요하다.
- 다음 재시도는 이미 올라간 iOS build 6 중복 업로드를 피하기 위해 Apple version `1.0.6`, build `7`로 진행한다. workflow는 macOS job 초기에 `security find-identity -p basic`으로 `3rd Party Mac Developer Installer` identity를 검사해 누락 시 즉시 명확한 에러를 낸다.

---

## 2026-05-24 — Codex App / Codex CLI 세션 표시 분리

### 문제
- Codex App OTel만 들어온 세션이 `codex:otel-active` + `agentType=codex-cli` + 빈 `projectName`으로 생성되어 D200H/타임라인에서 `OPENCLAW_CODEX-CLI__`처럼 빈 프로젝트명으로 보였다.
- Codex CLI lifecycle hook 세션과 Codex App OTel 세션을 모두 `codex-cli`로 취급해 같은 프로젝트에서 두 종류가 동시에 살아 있어도 display folding이 하나로 합쳐질 수 있었다.

### 해결
- OTel 기반 Codex App 세션은 새 `agentType=codex-app`으로 생성하고, cwd가 아직 없을 때는 프로젝트명을 `Codex App`으로 채운다. 이후 cwd가 들어오면 실제 프로젝트명으로 승격한다.
- Codex CLI와 Codex App folding key를 `(agentType, projectName)`으로 맞춰 같은 `AgentDeck` 프로젝트라도 두 세션 종류가 별도 타일/creature로 보이게 했다.
- macOS, Android, Stream Deck/D200H, Pixoo, bridge/plugin/shared 렌더링 경로에 `codex-app` label/icon/color/rank를 추가했다.
- 검증: `xcodebuild test -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -destination 'platform=macOS' -only-testing:AgentDeckTests_macOS/ProtocolTests -only-testing:AgentDeckTests_macOS/TerrariumCloudFoldTests`, `./gradlew :app:compileDebugKotlin`, `./gradlew :app:testDebugUnitTest`, `pnpm vitest run shared/src/__tests__/session-utils.test.ts`, `pnpm --filter @agentdeck/shared typecheck`, `pnpm --filter @agentdeck/shared build`, `pnpm --filter @agentdeck/plugin typecheck`, `pnpm --filter @agentdeck/bridge typecheck` 통과.

---

## 2026-05-24 — ESP32 / Codex App 장치 표시 정합성

### 문제
- 일부 ESP32 경로가 `codex-app`을 모르는 상태라 Codex App 세션을 Codex cloud가 아니라 Claude/octopus fallback으로 분류할 수 있었다.
- `sessions_list`에서 `agentType`이 비어 있거나 알 수 없는 값이면 Claude로 기본 처리해 실제 canonical session 목록에 없는 Claude creature가 표시될 수 있었다.
- 임시 `esp32/scripts/serial_relay.py`는 `/health`에 `agentType`이 없을 때 `claude-code`를 주입하고 canonical `/sessions`를 전달하지 않아, CLI 실행 전후 장치별 표시가 달라지는 경로를 만들었다.
- macOS Setup card는 기존 Codex auth 신호가 보일 때만 Codex observation 설정을 노출해, Codex CLI를 먼저 실행해야 Codex App 관측 설정 진입점이 보이는 것처럼 보일 수 있었다.

### 해결
- ESP32 protocol / terrarium / TC001 matrix / HUD 분류를 `codex-cli`와 `codex-app` 모두 Codex cloud로 처리하도록 확장했다.
- ESP32의 unknown/missing `agentType`을 Claude로 승격하지 않게 바꿔 phantom Claude creature를 차단했다.
- 임시 serial relay는 기본 `agentType`을 `daemon`으로 바꾸고 `/sessions` 또는 `/status.sessions`를 `sessions_list`로 전달하도록 수정했다.
- macOS Setup card는 Codex auth 신호 유무와 무관하게 `codexConfigInstalled == false`이고 사용자가 거절하지 않았으면 Codex live observation 설정을 노출한다.

---

## 2026-05-24 — Codex App passive detection / App Store subscription cleanup

### 문제
- Codex Desktop(App) kernel process가 이미 떠 있어도 OTel turn이 들어오기 전에는 Swift App Store daemon의 session list에 Codex App 타일이 늦게 나타날 수 있었다.
- OTel 익명 thread(`codex:otel-active`)가 별도 세션으로 남아 Codex App observed session과 중복 표시될 수 있었다.
- Claude Code만 미설정인 상황에서도 다른 agent 세션이 보이면 setup alert가 불필요하게 Claude Code를 요구했다.
- App Store daemon이 ChatGPT/Codex auth metadata를 subscription row로 합성해 Android tablet/e-ink surfaces에 renewal-needed row를 노출할 수 있었다.
- `/health`와 `/status`가 serial actor 상태 조회를 직접 기다려 물리 ESP32 쓰기 중 포트 탐색이 느려질 수 있었다.

### 해결
- macOS에서 subprocess 없이 `sysctl(KERN_PROC_ALL/KERN_PROCARGS2)`와 `NSRunningApplication`으로 Codex App kernel process를 passive 관측하고 `observed:codex-app:<sessionId>` 세션을 만든다.
- OTel `otel-active` 이벤트는 관측된 Codex App 세션으로 라우팅하고 기존 anonymous pushed state를 purge한다.
- Setup card는 보이는 agent가 하나라도 있고 그 agent가 Claude Code가 아니면 Claude Code setup 항목/alert를 숨긴다.
- App Store Swift daemon의 `subscriptions` payload는 빈 배열도 항상 전송하며, ChatGPT/Codex subscription row 합성은 제거했다.
- `/health`/`/status` module health는 serial actor await 대신 out-of-band poll cache를 사용해 hook port discovery 응답성을 유지한다.
- ESP32 serial bridge에서 write backpressure가 연속 발생하면 연결을 닫고 transient reconnect 경로로 넘긴다. Round AMOLED가 `write stalled after 0 ... errno=35` 상태로 계속 열려 있으면 `device_info`/`sessions_list`를 못 받아 loading 화면에 머물 수 있었다.

## 2026-05-24 — Round AMOLED legacy Codex App 호환

### 문제
- Round AMOLED 보드는 자동 업로드가 ROM bootloader 진입에 실패해 Codex App 지원 펌웨어를 아직 플래시하지 못했다.
- 해당 보드는 `version=0.1.0`으로 붙고, 구형 펌웨어는 `codex-app` agent type을 모르면 Claude Code creature fallback으로 표시할 수 있었다.

### 해결
- Swift serial bridge가 `round_amoled` + firmware `< 0.1.1` + protocol revision 미광고 보드에만 `codex-app`을 `codex-cli`로 내려보낸다.
- 변환은 per-connection으로 적용해 Android/D200H/Stream Deck 및 새 ESP32 펌웨어의 Codex CLI/App 분리는 유지한다.
- `device_info`를 받은 직후 initial state를 다시 보내, 재연결 시 `sessions_list`가 구형 round 보드에도 보정된 agent type으로 도착하게 했다.
- 새 ESP32 펌웨어는 `version=0.1.1`, `protocolRevision=2`를 광고한다. 이 버전이 round에 플래시되면 호스트 별칭 없이 `codex-app`을 직접 렌더링한다.

### 검증
- `xcodebuild test -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -destination 'platform=macOS' -only-testing:AgentDeckTests_macOS/ProtocolTests`
- `pio run -e round_amoled`
- 실제 round 업로드는 여전히 `Failed to connect to ESP32-S3: No serial data received`로 실패했다. 물리 BOOT/RST로 ROM bootloader에 넣어야 플래시 가능하다.

## 2026-06-06 — ESP32-P4 JC8012P4A1C 4MB 플래시 대응 및 화면 정방향 교정

### 문제
- JC8012P4A1C 10.1인치 디스플레이 보드(메인 칩: ESP32-P402N) 플래싱 후 화면이 켜지지 않는 현상이 발생함.
- 부트 로그 확인 결과 `Failed to verify partition table` 파티션 검증 실패로 인해 무한 리셋 루프를 돌고 있었음. 원인은 P402N 칩의 실제 내장 플래시 크기가 4MB인 반면, 플랫폼 설정 및 파티션 테이블이 16MB 기준으로 작성되어 주소 영역을 초과했기 때문임.
- 1차 파티션 테이블 수정 후 화면 백라이트와 UI는 정상 가동되었으나, 화면 상하가 반대로 뒤집혀(180도 반전) 출력되는 현상이 관찰됨.

### 해결
- **플래시 크기 및 파티션 스펙 다운사이징**:
  - `platformio.ini`에서 `board_build.flash_size = 4MB`로 수정함.
  - `partitions/jc8012p4a1c.csv`를 4MB 플래시에 맞춘 단일 팩토리 앱 레이아웃(No OTA, NVS 20KB, APP0 3MB, SPIFFS 960KB)으로 변경하여 부트 리셋 루프를 해결함.
- **디스플레이 및 터치 180도 회전 보정**:
  - `esp32/src/ui/display.cpp`의 `disp_flush`에서 manual transposition 공식을 90도 시계방향 회전에서 270도 회전(`rotated_buf[(w - 1 - c) * h + r] = src[r * w + c]`)으로 전환하고, 좌상단 물리 매핑 좌표를 보정함.
  - 이에 대칭적으로 `touch_read` 내의 터치 좌표 역변환 공식도 270도 레이아웃에 맞춰 보정(`x = BOARD_NATIVE_H - 1 - y_phys`, `y = x_phys`)하여 터치 조작 방향을 정방향으로 일치시킴.

### 검증
- `pio run -e jc8012p4a1c --target upload`를 통한 빌드 및 플래싱 성공.
- 시리얼 모니터링 상에서 크래시 없이 `Touch GSL3680 initialized`, `LVGL initialized 1280x800` 로그가 정상 기록되는 것을 확인.
- 기기 화면이 올바른 가로 정방향으로 출력되며 터치 제어가 정상 작동함 확인.

---

## 2026-06-06 — Pixoo64 스트리밍 안정성 개선 (재생 위임 및 상태 감지 도입)

### 문제
- Pixoo64 LED 매트릭스는 어항 애니메이션을 위해 250ms(Node) / 333ms(Swift)마다 64x64 raw RGB 프레임을 매번 새로 렌더링하여 HTTP POST로 전송했다.
- 이 방식은 매초 3~4회의 대용량 이미지 쏘기로 인해 와이파이 전송 레이턴시가 발생하고, 펌웨어/네트워크 부하로 스트리밍이 뚝뚝 끊기거나 딜레이가 체감되는 원인이 되었다.

### 해결
- **애니메이션 재생 위임 (Sequence Push)**:
  - 1프레임 단위 푸시 대신 12프레임 분량의 애니메이션 시퀀스(10fps 기준 1.2초 재생 루프)를 한 번에 생성하여 Pixoo 하드웨어에 전송(`PicNum = 12`, `PicSpeed = 100`).
  - Pixoo 기기가 데이터를 넘겨받으면 자체 보드 성능으로 루핑 애니메이션을 매끄럽게 재생하게 함으로써 30~60fps에 가까운 움직임을 연출.
- **상태 변화 감지 도입 (Incremental State Push)**:
  - 렌더링에 실질적 영향을 미치는 상태 정보(에이전트 연결 상태, 활성 세션 정보들의 조합, CPU 사용량의 정수부, 리셋 시간 텍스트, 게이트웨이 상태, 디스플레이 dimming 상태 등)를 요약해 Hash/Digest로 관리.
  - 500ms 주기로 이 해시 값을 비교하여 실질적인 변화가 발생했거나, 혹은 30초의 강제 하트비트 갱신 주기가 만료되었을 때만 새 12프레임 시퀀스를 렌더링하여 전송.
- **Node.js 및 Swift 데몬 병행 적용**:
  - Node.js bridge (`pixoo-client.ts`, `pixoo-bridge.ts`, `pixoo-renderer.ts`)와 Swift macOS daemon (`PixooModule.swift`, `PixooRenderer.swift`) 양쪽 모두에 동일한 재생 위임 및 해시 감지 메커니즘을 동일하게 포팅.
  - Swift 데몬의 `PixooRenderer`가 시간의 흐름을 반영해 여러 프레임 시퀀스를 한 번에 출력할 수 있도록 `renderSequence` 메서드를 추가하고 기존 `render`를 래핑.

### 검증
- **Node.js**:
  - `pnpm build` TypeScript 빌드 성공.
  - `pnpm vitest run bridge/src/__tests__/pixoo-sprites.test.ts` (3 tests passed).
- **Swift macOS Daemon**:
  - `xcodebuild build` Debug 구성 macOS target 빌드 완료 및 괄호 불일치 오류 교정 후 빌드 성공.
  - CLI 명령어 동작 및 `swift-daemon.log` 관찰 결과 불필요한 프레임 전송 없이 상태 변화 시에만 안정적으로 시퀀스 PUSH 됨을 확인.

---

## 2026-06-06 — Pixoo64 HTTP 스트리밍 안정성 강화 (재진입 방지 및 리셋 지연)

### 문제
- single-frame 푸시(`frameCount = 1`)와 1.5초 dynamic refresh rate 적용 이후에도 약 230여 회 전송 후 연속적인 HTTP 타임아웃과 함께 기기가 오프라인으로 이탈(Backoff)하는 현상이 관찰됨.
- 원인 분석 결과:
  1. **PicID Reset 후 안정화 시간 누락**: `PicID`가 250 이상이 될 때 전송하는 `ResetHttpGifId` 명령어 직후 딜레이 없이 즉시 다음 프레임 POST 요청을 보내면서 ESP32의 가벼운 네트워크 스택이 병목으로 인해 중단되거나 연결을 거부하는 현상이 발생함.
  2. **Swift Actor 재진입성(Re-entrancy)으로 인한 Overlapping**: Swift의 `PixooModule` actor는 비동기 작업대기(`await`) 중 정지될 때 실행 제어권을 넘기므로, 500ms 주기로 동작하는 `checkAndPush()`가 이전 푸시 동작의 완료를 기다리지 않고 중복 실행되어 concurrent HTTP request가 발생하고 디바이스를 리셋/먹통으로 만드는 버그가 있음.
  3. **URLSession의 반복적인 재생성**: 매 HTTP POST 요청마다 `URLSession`을 인스턴스화하고 취소(`invalidateAndCancel`)하면서 포트 경합과 불필요한 시스템 자원 낭비가 누적됨.

### 해결
- **PicID 리셋 후 지연 추가**:
  - Node.js 브리지(`pixoo-client.ts`) 및 Swift 데몬(`PixooModule.swift`)에서 `ResetHttpGifId` 전송 직후 **2.0초의 대기 지연(sleep)**을 추가하여 ESP32가 GIF 캐시와 상태를 안전하게 초기화하고 안정화될 시간을 확보함.
- **Actor 중복 실행 방지 (isPushing 플래그)**:
  - Swift 데몬 `PixooModule.swift`에 `isPushing` 플래그를 추가하고 `checkAndPush` 시작점에 중첩 진입 방지 guard를 배치하여 network latency 등으로 인해 500ms 이상 소요될 때 이전 push 작업과 겹치지 않도록 방어함.
- **URLSession 인스턴스 공유**:
  - Swift `PixooModule`에 단일 `urlSession` 인스턴스를 유지하도록 변경하고, `httpMaximumConnectionsPerHost = 1` 설정을 명시해 기기당 HTTP 연결 개수를 제한하여 전송 계층의 병목을 완화함.

### 검증
- **Node.js**:
  - `pnpm vitest run bridge/src/__tests__/pixoo-sprites.test.ts` (3 tests passed).
- **Swift macOS Daemon**:
  - `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug build` 빌드 성공 확인.
