# 2026-06-28 — D200H sleep/wake 후 OFFLINE 고착 (실제 원인 = state='disconnected' 오해석)

### 문제
macOS 잠자기 → 깨우면 Ulanzi D200H 가 OFFLINE 으로 남고 수동 개입 없이는 복구되지 않았다.

### 해결 (실제 근본 원인)
런타임 점검(lsof)으로 plugin↔Studio, plugin↔daemon WS 둘 다 ESTABLISHED·생존(15s ping-evict 통과) 확인 → WS 층은 멀쩡. 데몬 WS 프로브로 진짜 원인 발견: 데몬이 `state_update{state:'disconnected', allSessions:[]}` + `sessions_list{6 observed sessions}` 를 보내는데, `shared/src/d200h-layout.ts buildSessionDeck` 이 top-level `state==='disconnected'` 만 보고 **allSessions 무시한 채 OFFLINE hero** 를 그렸다. 데몬의 top-level state 는 **managed/focused 세션 기준** — sleep 으로 managed PTY 세션이 끝나고 observed(ps) 세션만 남으면 state='disconnected' 가 되어, 세션 6개가 살아있어도 OFFLINE.

Fix: OFFLINE 게이트에 `&& state.allSessions.length === 0` 추가(`5616ab73`). 진짜 링크끊김은 plugin store 가 `{state:'DISCONNECTED'(대문자), allSessions:[]}` 로 보내므로 여전히 OFFLINE.

### 함께 고친 latent 버그 (증상 원인은 아님)
점검 중 plugin-ulanzi 가 독립 WS 2개 중 **Ulanzi Studio 브리지**(vendored `vendor/ulanzi-api`)에만 재연결이 없음을 발견(데몬 링크는 wake-watchdog+backoff 있음). vendored `connect()` 는 1회만 열고 `onclose`→`Events.CLOSE` emit, `app.ts` 는 로그만. → `ReconnectSupervisor`(`plugin-ulanzi/src/reconnect-supervisor.ts`, backoff+10s wake-watchdog+connect-timeout 인플라이트 가드) 추가(`2cd6221a`). 이번 증상의 원인은 아니지만 sleep 시 Studio 소켓 사망 시나리오 대비 견고성 개선.

### 핵심 설계 결정
- **"disconnected" 두 의미 혼동이 핵심**: (1) plugin store.connected=false=진짜 링크끊김(대문자 DISCONNECTED+빈목록) vs (2) 데몬 session-state 'disconnected'(소문자)+세션존재. 레이아웃이 둘을 혼동 → allSessions 유무로 구분.
- **점검 순서 교훈**: WS "OFFLINE" 증상이라고 WS 재연결부터 의심하지 말 것. lsof 로 소켓 생존 먼저 확인 → 살아있으면 페이로드(브로드캐스트) 프로브로 렌더 입력을 직접 봐야 진짜 원인이 보인다. 첫 세션의 reconnect 진단은 실증 없이 코드만 보고 내린 오진이었다.
- **배포**: fix 가 shared → plugin-ulanzi esbuild 가 app.js 에 번들 → `pnpm package:install` → **Ulanzi Studio 재시작 필수**(Studio 는 플러그인 프로세스 kill 해도 자동 재기동 안 함).
- **검증**: 전체 1556 tests pass, coverage exit 0, repro(state=disconnected+세션 → OFFLINE=0/open=N) 로 증명, 설치본 app.js 에 게이트 번들 확인, 재시작 후 plugin(16972) 양 링크 재연결 확인. 실기 화면은 사용자 확인.
