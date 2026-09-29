# 2026-07-19 — App Store 제출 자산 완성 · GNB 단일소스화 · Build Health 토큰 게이트

### 문제

세 갈래가 한 세션에 모였다. (1) 제출 자산: 데모 하네스가 macOS에서 아예 동작하지 않았고(`-AgentDeckScreenshotURL` 무효), 시나리오에 OpenClaw·다중 세션·전체 타임라인이 없었으며, 스크린샷은 en 단일이었다. (2) iOS/iPadOS attention HUD가 반투명이라 겹친 패널 텍스트가 비쳐 읽을 수 없었다. (3) Pages GNB는 5벌 복붙이라 이미 세 번 드리프트했고, Build Health `:root` 별칭(--bg 등)은 값은 맞지만 `verify-tokens-sync` 게이트를 우회하고 있었다.

### 해결

- **하네스 2중 결함**: macOS 타깃이 `SWIFT_ACTIVE_COMPILATION_CONDITIONS`를 base에서 덮어써 Debug에도 `DEBUG` 플래그가 없었고(모든 `#if DEBUG` 컴파일 제외 — 바이너리 strings로 확인), 컴파일돼도 자체 데몬 `onReady`가 0.5s 뒤 핀을 덮어썼다. Debug 전용 `AGENTDECK_APP_STORE DEBUG` + 런치 인자 핀 우선순위로 수정 (`ddefa4f5`).
- **시나리오**: 30s 사이클, 콜드오픈 → 5세션(4에이전트, Claude×2) 순차 등장 → 전체 타임라인(포커스 해제) → attention → 전원 idle. 포커스 해제는 필드 생략이 아니라 **빈 문자열 전송**이어야 한다(`AgentStateHolder`가 생략 시 이전 값 유지). Codex 게이지는 7d 단독(실기 재현), Claude 게이지는 Tier-1이 못 만드는 데이터라 의도적 미발행.
- **HUD**: attention 카드에 불투명 ink 베이스 추가 (`58b86f68`) — 읽혀야 하는 유일한 HUD가 다른 패널과 같은 반투명이었다.
- **자산 파이프라인**: `record-appstore-previews.sh`(H.264 High L4.0, 28s, 10–12Mbps, 플랫폼별 정확 해상도) + `capture-appstore-screenshots.sh`(raw) + `compose-appstore-screenshots.py`(ko/en/ja 합성, Plex KR/JP 벤더링, 모노 킥커, 마케팅 토큰만). 미래 epoch로 피드를 새로 시작해야 콜드오픈이 잡힌다(루프 중 녹화는 직전 사이클 카드가 잔존). `validate-appstore-submission.sh` 로케일 순회 확장, 전체 통과.
- **GNB**: `scripts/pages-nav.html` 파샬 + `sync-pages-nav.mjs` 주입/`--check`(CI), Build Health는 생성 시 같은 파샬을 직접 읽음. 래퍼 클래스·`#lang` 정규화. 로컬 사이트 복제 + Chrome 스크린샷 5장으로 라이브 검증 (`b087cea6`).
- **토큰**: Build Health `:root`를 정본 이름 선언 + `var()` 별칭으로 재구성, `verify-tokens-sync.py` 7번째 미러 편입(f-string `{{}}` 언이스케이프, body 차트 hex는 lint 베이스라인 소관으로 제외).

### 핵심 설계 결정

- **스토어 스크린샷은 합성 프레임, 실사 배제** — 커밋된 데스크 사진에 실제 브라우저/터미널/개인 컨텍스트가 노출돼 심사 리스크. Apple 베젤도 그리지 않음(기기 프레임 반려 + 상표 회피). 캡션은 Tier-1 실기능만 서술.
- **산재 정리는 이동 대신 정본+게이트** — 이번 GNB가 그 실례. 단, 사용자 피드백: 기존 구조 고수가 기본값이 되면 안 되며, 다음 산재 지점에서는 물리 이동도 동등하게 검토할 것.
- 디자인 시스템 점검 결과 남은 부채: 대시보드 UI의 레거시 팔레트(TerrariumHUD #FBBF24 등 vs `--ui-*` 정본), Build Health 본문 차트 hex — 둘 다 점진 마이그레이션 대상으로 기록만.
