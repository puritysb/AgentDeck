# 2026-07-02 — 데몬 로그 위생: iDotMatrix 60초 respawn 근본 원인 + BLE sync 반복 사이클 억제 + TRMNL `/api/setup/` trailing-slash 404

### 문제
`~/.agentdeck/daemon-stderr.log`가 iDotMatrix BLE sync의 60초 주기 respawn 로그(connect→send→disconnect→respawn, code=0)로 도배(clean exit 4,057행, 비정상 0행). 조사에서 근본 원인 3건 확정:
1. **iDotMatrix `sync.py` 워치독 굶주림** — bridge-gone 워치독(30s)의 `last_bridge_ok`가 frame fetch에서만 갱신되는데, host display dimmed 경로는 frame fetch를 건너뛰므로(display-state fetch는 성공하는데도) 30초마다 "Bridge unreachable" clean exit → 데몬이 60초 백오프로 영구 respawn. Timebox `sync_ble.py`는 이미 display-state fetch에서 갱신하고 있었음(패리티 누락).
2. **로그 truncate-on-start** — `cli.ts` daemon 백그라운드 fork가 `daemon-std{out,err}.log`를 `'w'`로 열어 재시작마다 이전 로그 소실 → 야간 기기 인시던트("not responding")와 관측성 로그(`back after`/`device log from`)의 며칠치 대조가 구조적으로 불가.
3. **(로그가 드러낸 별건) TRMNL `/api/setup/` 404** — 패널이 매 wake마다 `returned code is not OK. Code - 404` 보고. 펌웨어 v1.5.12 `getDeviceCredentials()`(bl.cpp:1600)가 **trailing slash 포함** `{base}/api/setup/`을 GET하는데 Node·Swift 허브 모두 exact match(`=== '/api/setup'`)라 404 → api_key 저장이 영영 안 돼 매 wake 재시도 (frames는 `/api/display` soft MAC auth로 정상 렌더).

### 해결
- **`bridge/src/idotmatrix/sync.py`** — display-state fetch 성공 시(connect 블록 + 1c 루프) `last_bridge_ok` 갱신. 성공한 display-state 응답 = bridge 생존 증거.
- **`bridge/src/ble-sync-spawn.ts` `createSyncCycleSquelch()`** — 동일 exit 사이클은 처음 2회만 전체 로그, 이후 start/exit 쌍 억제 + 시간당 카운트 요약(`suppressed N repeats … latest:`). 다른 exit(새 에러 텍스트·비정상 code·5분+ 정상 가동 후 재발)은 요약 flush 후 즉시 로그. 사이클 identity는 output tail 기준: hex/숫자 마스킹 + ` | ` 세그먼트 dedupe/sort(링버퍼가 같은 재시도 에러를 1개 또는 2개 캡처해도 동일 사이클). iDotMatrix(모듈 단일)·Timebox(엔트리별) 매니저 양쪽 wiring.
- **`bridge/src/cli.ts`** — fork 로그를 append(`'a'`)로 열고 5MB 초과 시 `.1`로 rotate. launchd 경로(StandardErrorPath)는 원래 append.
- **`bridge/src/daemon-server.ts` + `apple/.../Server/HttpServer.swift`** — TRMNL API 라우트 trailing-slash 무시 매칭(Node: `trmnlPath` 정규화, Swift: `route()`에서 normalizedPath 비교). 양 허브 패리티.

### 검증
- vitest 89파일/1626 pass(신규 `ble-sync-squelch.test.ts` 5케이스), `xcodebuild AgentDeck_macOS` BUILD SUCCEEDED.
- 라이브: 수정 배포 후 `sync.py` child가 기존 30초 사망 주기를 넘겨 지속 생존; TRMNL 다음 wake부터 setup 404 소멸 확인. Timebox "not found" 루프(기기 꺼짐)는 2회 로그 후 억제.
- 부수 복구: LaunchAgent plist가 과거 설치 시점의 pnpm Node 22 절대경로를 고정하고 있어 Node 26 업그레이드 후 better-sqlite3 ABI 불일치로 APME가 죽어 있었음 — better-sqlite3를 Node 26으로 재빌드 + `daemon uninstall/install`로 plist 재생성(이제 `agentdeck` shim + PATH 해석), APME/MLX judge 복구.

---
