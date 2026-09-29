# 2026-06-23 — TRMNL e-ink: 안정화 + 정보밀도 재설계 + 세션 goal

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
