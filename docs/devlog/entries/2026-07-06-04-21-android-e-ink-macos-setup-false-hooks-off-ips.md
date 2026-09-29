# 2026-07-06 — 라운드 21: Android e-ink 다중행 + macOS Setup 카드 false "hooks off" + IPS10 WiFi 영속화

### 문제
라운드 20 후속 3건. (1) Android e-ink 타임라인이 최신 1건만 커서 "단편적·정보량 부족" 지적. (2) macOS Dashboard가 Claude/Codex hook이 **연결 안 된 것처럼 보인다** — 실제로는 세션·타임라인 정상 렌더 중인데 중앙 SETUP 카드가 "Live session hooks off"/"Codex live observation off"를 계속 띄움. (3) IPS10이 프로비저닝된 데몬 엔드포인트를 재부팅 후 잃어 auto-reconnect 불가(동시 세션 in-flight).

### 해결
- **Android e-ink 적응형 다중행** (`7f61b8a2`, `EinkTimelinePanel.kt`): 최신 항목을 크게 + 구분선 아래 컴팩트 2건까지. 개수는 primary 메시지 길이에 적응(≤90자→+2, ≤240→+1, 초과→단독)해 무스크롤 글랜스 화면이 넘치지 않음. Moaan e-ink 실기 확인(primary+secondary+구분선 렌더).
- **macOS Setup 카드 false-nag** (`c48cf8b0`, `SetupNeededCard.swift`): 두 항목은 로컬 UserDefaults 플래그 `hooksInstalled`/`codexConfigInstalled`로만 판단 — 이 플래그는 **앱 자체 인앱 설치 경로로만** true. CLI가 hook을 깔면(이 머신: `~/.claude/settings.json` + `~/.codex/config.toml` 실재, prefs 플래그는 0) 영영 false → Tier-2에서 영구 nag. 샌드박스라 파일 검증도 불가. Fix: `isUsingExternalDaemon`이면 외부 Node 허브가 hook 소유·중계하므로 두 nudge suppress.
- **IPS10 WiFi 영속화** (`67934f94`, 동시 세션 작업 통합): SSID/password + bridge IP/port/token을 NVS Preferences("adwifi")에 저장·부팅 시 재로드해 WS 재연결. `Net::wifiConfigured()`(NVS 인지) + provision 전 STA 모드 재진입(hosted C6 radio 파킹 대비). 데몬측 `touchWifiEsp32Socket`로 인바운드 프레임마다 lastSeenMs 갱신(stale 회수 방지).

### 핵심 설계 결정
- e-ink는 "한 줄"이 아니라 "글랜스"가 목표 — 고정 N행이 아니라 **메시지 길이 적응**이 무스크롤 화면에 맞음.
- macOS 대시보드는 **항상 순수 WS 클라이언트** — 세션은 허브의 `sessions_list` 중계로만 옴(자기 `pushedSessionsById` 미사용, 외부데몬 모드). 따라서 hook 세션 렌더는 by-construction 정상이고, "미연결처럼 보임"은 **설치-추적 플래그의 false-negative**일 뿐 연결 문제가 아님. 독립 코드탐색(BridgeConnection/AgentStateHolder/DaemonService)으로 교차검증.
- 별개 실패모드 주의: Swift가 Node 순단 중 owner로 promote하면 자기 빈 데몬을 서빙해 **세션 0건**(연결레벨 empty). 오늘 증상(세션은 보이고 카드만 오표시)과 구분됨. promotion 가드 `DaemonService.swift:534-549`.
- 검증: vitest 1226/1226, `tsc -p bridge` green, macOS xcodebuild green, Android `:app:assembleRelease` green, inkdeck/ips10 펌웨어 빌드 SUCCESS, 라이브 데몬 E2E(합성 codex/opencode 턴 + 실제 `opencode run`) + Moaan e-ink 실기 스크린샷.
