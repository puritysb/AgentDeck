# 2026-09-02 — OpenClaw Gateway 재시작 폭풍: 설치본 둘이 한 상태 디렉터리를 두고 싸웠고, 데몬은 매번 "정상 복구"로 읽었다

### 문제

Android 기기의 OpenClaw 행이 `gateway_not_found`로 떴다가 돌아오기를 반복.
데몬 로그에는 90분 사이 `Gateway disconnected → lost → detected → connected`
사이클 11회 — 그런데 각 사이클의 끝은 `connected`라 아무 표면도 이상을
말하지 않았다.

### 해결

원인은 AgentDeck 밖에 있었고, Gateway 자체 로그가 문장으로 적어 두고 있었다.
00:26 KST의 실패한 업데이트가 launchd 유닛(`ai.openclaw.gateway`)의
실행 바이너리를 **앱 관리 런타임(`~/.openclaw/tools`)에서 Homebrew 글로벌
복사본으로** 바꿔치기했고(둘 다 2026.8.1), Homebrew 쪽 Gateway는
`Agent identity migration requires stopped-writer maintenance`로 부팅을
거부 — 다른 복사본이 `~/.openclaw/state`를 쥐고 있어서다
(`another Gateway owns that state directory`). KeepAlive가 실패마다 재기동해
OpenClaw의 자체 차단기가 `13 unclean boots within 300s`까지 갔고, 그 위에서
LINE 플러그인 설치·설정 변경이 `SIGUSR1`/`SIGTERM` 재시작을 여섯 번 더 눌렀다.
데몬의 disconnect 타임스탬프 8건이 이 시각과 초 단위로 일치한다.

정리: 관리 런타임의 CLI로 `gateway install --force`를 **관리 node로 명시
실행**해(shim은 `env node`라 Homebrew node를 execPath로 굽는다) plist를
관리 node+openclaw로 되돌리고, Homebrew 글로벌·pnpm 글로벌(2026.4.25, 6월
잔여물) 복사본을 제거했다. 앱이 이미 설치해 둔 정본 래퍼
`~/.openclaw/bin/openclaw`가 PATH에 없어 `openclaw`가 Homebrew로 풀리던 것이
경합의 출발점이었으므로 PATH 최우선에 넣었다. Bonjour 이름의 "(2)"는 Gateway
중복이 아니라 Mac 로컬 호스트명(`sbstudio-(2).local`)의 접미였다 — 오독 정정.

### 핵심 설계 결정

**"매번 복구되는 링크"는 관측 불가능한 장애다.** 그래서
`bridge/src/openclaw-gateway-stability.ts`: 10분 창 3회 disconnect를
불안정으로 판정하고, Gateway 로그 꼬리 64KB에서 OpenClaw이 남긴 원인 문장을
우선순위(상태 소유권 충돌 > 재시작 차단기 > 마이그레이션 실패 > 설정 재시작 >
SIGTERM)로 읽어 `/health`·`/status`의 `gatewayInstability`와 `openclaw-gateway`
세션의 `error` 타임라인 행으로 낸다. 프로토콜 변경 없이 모든 표면(Android·
e-ink 포함)에 닿는 채널이 타임라인이기 때문이다. 실기 검증: idle 상태에서
Gateway를 4회 재시작해 로그 경고·`/health` 진단 객체·타임라인 행 생성을 확인.
fixture는 정규식이 아니라 실제 로그 문장이다. 원인 문장이 꼬리 밖이면
"reason not in the Gateway log"라고 말한다 — 모르는 것을 모른다고.

---
